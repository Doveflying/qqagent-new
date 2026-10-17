<#
.SYNOPSIS
    Switch the model used by QQ Agent according to a time table (hot, no restart).

.DESCRIPTION
    Reads config/model-schedule.json, picks the rule matching "now", then applies it.

    Two modes per rule:
      "default" - change the global default model (every role follows it)
      "chat"    - override only the chat role (llm.roles.chat); emotion / summary /
                  facts / vision keep following the global default. Safer with
                  small free models, because those auxiliary tasks parse JSON.

    Idempotent: when the running model already matches, nothing is written.

    Ownership of overrides:
      The chat override set by this script is recorded in
      config/model-schedule.state.json. When the window ends, the script clears
      that override again - but only while it still holds the value the script
      wrote. If you changed the chat override by hand in the panel, the script
      leaves it alone and says so.

.PARAMETER Apply
    Actually perform the switch. Without it the script only prints the plan.

.PARAMETER ConfigPath
    Time table path. Defaults to <repo>/config/model-schedule.json

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/model-schedule.ps1
    powershell -ExecutionPolicy Bypass -File scripts/model-schedule.ps1 -Apply
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $ConfigPath = Join-Path $repoRoot 'config\model-schedule.json'
}
$StatePath = Join-Path (Split-Path -Parent $ConfigPath) 'model-schedule.state.json'

function Write-Step([string]$msg) { Write-Host $msg }

function Send-Json([string]$url, [hashtable]$payload) {
    $json = $payload | ConvertTo-Json -Depth 5
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' `
        -Body $bytes -TimeoutSec 20 -ErrorAction Stop
}

function Read-State {
    if (Test-Path -LiteralPath $StatePath) {
        try { return Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    return [pscustomobject]@{ chatOverride = '' }
}

function Write-State($state) {
    $json = $state | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($StatePath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------- 1. load the schedule ----------
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Error "Schedule file not found: $ConfigPath"
    exit 2
}
$plan = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$state = Read-State

$agentUrl = 'http://127.0.0.1:3081'
if ($plan.agentUrl) { $agentUrl = ([string]$plan.agentUrl).TrimEnd('/') }

$now = Get-Date
$dayName = $now.DayOfWeek.ToString().Substring(0, 3)   # Mon / Tue / ...
$nowMin = $now.Hour * 60 + $now.Minute

function ConvertTo-Minutes([string]$hhmm) {
    if ($hhmm -notmatch '^\s*(\d{1,2}):(\d{2})\s*$') { throw "Bad time format (want HH:mm): $hhmm" }
    return [int]$Matches[1] * 60 + [int]$Matches[2]
}

# ---------- 2. match a rule ----------
$chosen = $null
$chosenName = 'default'

foreach ($rule in @($plan.rules)) {
    if (-not $rule.provider -or -not $rule.model) { continue }   # skip unfinished rules

    if ($rule.days -and @($rule.days).Count -gt 0) {
        $days = @($rule.days)
        if ($days -notcontains 'all' -and $days -notcontains $dayName) { continue }
    }

    $from = ConvertTo-Minutes ([string]$rule.from)
    $to = ConvertTo-Minutes ([string]$rule.to)

    # allow windows crossing midnight: 22:00 -> 02:00
    if ($from -le $to) {
        $hit = ($nowMin -ge $from) -and ($nowMin -lt $to)
    } else {
        $hit = ($nowMin -ge $from) -or ($nowMin -lt $to)
    }

    if ($hit) {
        $chosen = $rule
        if ($rule.name) { $chosenName = [string]$rule.name } else { $chosenName = "$($rule.from)-$($rule.to)" }
        break
    }
}

if ($chosen) {
    $targetProvider = [string]$chosen.provider
    $targetModel = [string]$chosen.model
    $mode = 'default'
    if ($chosen.mode) { $mode = [string]$chosen.mode }
} else {
    $targetProvider = [string]$plan.default.provider
    $targetModel = [string]$plan.default.model
    $mode = 'default'
    if ($plan.default.mode) { $mode = [string]$plan.default.mode }
}

if ($mode -ne 'default' -and $mode -ne 'chat') {
    Write-Error "Unknown mode '$mode' (allowed: default | chat)"
    exit 2
}
if ($mode -ne 'chat' -and (-not $targetProvider -or -not $targetModel)) {
    Write-Error "No target model for rule '$chosenName'. Edit config/model-schedule.json"
    exit 2
}

Write-Step ("[{0}] {1} {2} -> rule: {3} (mode: {4})" -f $now.ToString('yyyy-MM-dd HH:mm'), $dayName, $now.ToString('HH:mm'), $chosenName, $mode)

# ---------- 3. read current runtime state ----------
try {
    $roleDoc = Invoke-RestMethod -Uri "$agentUrl/api/llm/roles" -TimeoutSec 10 -ErrorAction Stop
    $ovDoc = Invoke-RestMethod -Uri "$agentUrl/api/overview" -TimeoutSec 10 -ErrorAction Stop
} catch {
    Write-Error "Cannot reach agent at $agentUrl : $($_.Exception.Message)"
    exit 3
}

$chatRole = @($roleDoc.roles | Where-Object { $_.role -eq 'chat' })[0]
if (-not $chatRole) { Write-Error 'Chat role not found in /api/llm/roles'; exit 3 }

$ovProvider = [string]$chatRole.overrideProvider
$ovModel = [string]$chatRole.overrideModel
$ovKey = if ($ovProvider) { "$ovProvider/$ovModel" } else { '' }
$globalProvider = [string]$ovDoc.llm.defaultProvider
$globalModel = [string]$ovDoc.llm.defaultModel

Write-Step ("           global : {0}/{1}" -f $globalProvider, $globalModel)
Write-Step ("           chat   : {0}" -f $(if ($ovKey) { "override $ovKey" } else { "inherit global" }))

$pending = $false

# ---------- 4a. chat mode: set the override ----------
if ($mode -eq 'chat') {
    $target = "$targetProvider/$targetModel"
    if ($ovKey -eq $target) {
        Write-Step '           chat override already in sync.'
    } else {
        Write-Step ("           chat override -> {0}" -f $target)
        $pending = $true
        if ($Apply) {
            try {
                $res = Send-Json "$agentUrl/api/settings" @{ patch = @{
                    'llm.roles.chat.provider' = $targetProvider
                    'llm.roles.chat.model'    = $targetModel
                } }
            } catch { Write-Error "Switch request failed: $($_.Exception.Message)"; exit 4 }
            if (-not $res.ok) { Write-Error "Switch rejected: $($res.error)"; exit 4 }
            Write-State ([pscustomobject]@{ chatOverride = $target })
            Write-Step ("           applied (hot). recorded as owned by schedule.")
        }
    }
}

# ---------- 4b. default mode: release the override, then ensure the global model ----------
if ($mode -eq 'default') {
    if ($ovKey -and $state.chatOverride -and $ovKey -eq [string]$state.chatOverride) {
        Write-Step ("           releasing chat override {0} (set by schedule earlier)" -f $ovKey)
        $pending = $true
        if ($Apply) {
            try {
                $res = Send-Json "$agentUrl/api/settings" @{ patch = @{
                    'llm.roles.chat.provider' = ''
                    'llm.roles.chat.model'    = ''
                } }
            } catch { Write-Error "Release request failed: $($_.Exception.Message)"; exit 4 }
            if (-not $res.ok) { Write-Error "Release rejected: $($res.error)"; exit 4 }
            Write-State ([pscustomobject]@{ chatOverride = '' })
            Write-Step '           chat override cleared, back to inheriting global.'
        }
    } elseif ($ovKey) {
        Write-Step ("           note: chat override {0} was not set by the schedule, leaving it alone." -f $ovKey)
    }

    if ($globalProvider -eq $targetProvider -and $globalModel -eq $targetModel) {
        Write-Step '           global default already in sync.'
    } else {
        Write-Step ("           global default -> {0}/{1}" -f $targetProvider, $targetModel)
        $pending = $true
        if ($Apply) {
            try {
                $res = Send-Json "$agentUrl/api/providers/set-default" @{ providerKey = $targetProvider; model = $targetModel }
            } catch { Write-Error "Switch request failed: $($_.Exception.Message)"; exit 4 }
            if (-not $res.ok) { Write-Error "Switch rejected: $($res.error)"; exit 4 }
            Write-Step ("           applied (hot): {0}/{1}" -f $targetProvider, $targetModel)
        }
    }
}

if (-not $pending) { Write-Step '           nothing to do.'; exit 0 }
if (-not $Apply) { Write-Step '           [dry-run] add -Apply to execute.'; exit 0 }
exit 0
