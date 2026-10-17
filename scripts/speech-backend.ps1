<#
.SYNOPSIS
    Prefer the local VoiceStudio speech backend, fall back to the cloud one.

.DESCRIPTION
    Probes the local VoiceStudio OpenAI-compatible speech API. If it answers, the
    TTS role (and its voice id) is pointed at the local provider; otherwise at the
    cloud provider. Idempotent: nothing is written when the running config already
    matches the expected backend.

    Only the TTS role is managed here. Local ASR takes ~19s per call on this
    machine, which does not fit a chat turn, so ASR stays on the cloud provider.

.PARAMETER Apply
    Actually perform the switch. Without it the script only prints the plan.

.PARAMETER ConfigPath
    Path of speech-backend.json. Defaults to <repo>/config/speech-backend.json
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $ConfigPath = Join-Path $repoRoot 'config\speech-backend.json'
}

function Write-Step([string]$msg) { Write-Host $msg }

function Send-Json([string]$url, [hashtable]$payload) {
    $json = $payload | ConvertTo-Json -Depth 5
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' `
        -Body $bytes -TimeoutSec 20 -ErrorAction Stop
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Error "Config not found: $ConfigPath"
    exit 2
}
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$agentUrl = ([string]$cfg.agentUrl).TrimEnd('/')

# ---------- 1. is the local backend up? ----------
$localUp = $false
try {
    $null = Invoke-RestMethod -Uri ([string]$cfg.probeUrl) -TimeoutSec 5 -ErrorAction Stop
    $localUp = $true
} catch {
    $localUp = $false
}

$which = if ($localUp) { 'local' } else { 'cloud' }
$target = $cfg.$which
$targetProvider = [string]$target.provider
$targetModel = [string]$target.model
$targetVoice = [string]$target.voice

if (-not $targetProvider -or -not $targetModel) {
    Write-Error "Target backend '$which' is missing provider/model in $ConfigPath"
    exit 2
}

$now = Get-Date
Write-Step ("[{0}] VoiceStudio probe: {1} -> use {2}" -f $now.ToString('yyyy-MM-dd HH:mm'), $(if ($localUp) { 'UP' } else { 'DOWN' }), $which)
Write-Step ("           target tts: {0}/{1}  voice={2}" -f $targetProvider, $targetModel, $targetVoice)

# ---------- 2. read what is running ----------
try {
    $roleDoc = Invoke-RestMethod -Uri "$agentUrl/api/llm/roles" -TimeoutSec 10 -ErrorAction Stop
    $setDoc = Invoke-RestMethod -Uri "$agentUrl/api/settings" -TimeoutSec 10 -ErrorAction Stop
} catch {
    Write-Error "Cannot reach agent at $agentUrl : $($_.Exception.Message)"
    exit 3
}

$ttsRole = @($roleDoc.roles | Where-Object { $_.role -eq 'tts' })[0]
if (-not $ttsRole) { Write-Error 'TTS role not found'; exit 3 }
$curProvider = [string]$ttsRole.provider
$curModel = [string]$ttsRole.model

$curVoice = ''
foreach ($item in @($setDoc.settings)) {
    if ($item.path -eq 'speech.tts.voice') { $curVoice = [string]$item.value; break }
}

Write-Step ("           current tts: {0}/{1}  voice={2}" -f $curProvider, $curModel, $curVoice)

# 已经在本地方案上时，不要用配置里的默认音色覆盖手动选择的音色
# （例如通过面板或 /voice 指令换过的音色，应该一直保留到下次切回云端）。
if ($which -eq 'local' -and $curProvider -eq $targetProvider -and $curModel -eq $targetModel -and $curVoice) {
    $targetVoice = $curVoice
}

$same = ($curProvider -eq $targetProvider) -and ($curModel -eq $targetModel) -and ($curVoice -eq $targetVoice)
if ($same) {
    Write-Step '           already on the expected backend, nothing to do.'
    exit 0
}

if (-not $Apply) {
    Write-Step '           [dry-run] add -Apply to execute.'
    exit 0
}

# ---------- 3. switch ----------
$patch = @{ patch = @{
    'llm.roles.tts.provider' = $targetProvider
    'llm.roles.tts.model'    = $targetModel
    'speech.tts.voice'       = $targetVoice
} }
try {
    $res = Send-Json "$agentUrl/api/settings" $patch
} catch {
    Write-Error "Switch request failed: $($_.Exception.Message)"
    exit 4
}
if ($res.ok) {
    Write-Step ("           switched to {0} backend (hot)" -f $which)
    exit 0
}
Write-Error "Switch rejected: $($res.error)"
exit 4
