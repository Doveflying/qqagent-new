<#
.SYNOPSIS
    QQ Agent 桌面控制台。
.DESCRIPTION
    一个 WinForms 小窗口，替代一堆 .cmd 和快捷方式：
      - 实时显示 Agent / NapCat / 语音代理 / VoiceStudio 的状态
      - 一键启动、停止、打开管理面板、修复登录
      - 后台每 30 秒用 watchdog 确认 QQ 是真在线（而不是"假登录"）
    由 QQAgent.vbs 无窗口调起。加 -SmokeTest 只跑一次状态刷新后退出（自检用）。
#>
[CmdletBinding()]
param([switch]$SmokeTest)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Repo 'start-all.cmd'))) {
    $Repo = 'C:\桌面图标\qwe\QQagent'
}

function Test-Port([int]$port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $port)
        $c.Close()
        return $true
    } catch { return $false }
}

function Get-AgentInfo {
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:3081/api/health" -TimeoutSec 2
        return @{
            up = $true
            connected = [bool]$h.runtime.onebot.connected
            selfId = $h.runtime.selfId
            uptime = [math]::Round($h.runtime.uptimeMs / 1000)
        }
    } catch { return @{ up = $false; connected = $false; selfId = 0; uptime = 0 } }
}

function Get-WatchdogLine {
    try {
        $node = (Get-Command node -ErrorAction Stop).Source
        $out = & $node (Join-Path $Repo 'scripts\watchdog.mjs') --verbose 2>&1
        $line = ($out | Where-Object { $_ -match 'ONLINE|OFFLINE|DOWN' } | Select-Object -Last 1)
        if ($line) { return [string]$line }
        return ''
    } catch { return '' }
}

$script:LastWatchdog = ''
$script:LastWatchdogAt = [datetime]::MinValue

# ---------------- 界面 ----------------
$form = New-Object Windows.Forms.Form
$form.Text = 'QQ Agent 控制台'
$form.ClientSize = New-Object Drawing.Size(470, 430)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)

$title = New-Object Windows.Forms.Label
$title.Text = 'QQ Agent'
$title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 16, [Drawing.FontStyle]::Bold)
$title.Location = New-Object Drawing.Point(16, 12)
$title.Size = New-Object Drawing.Size(200, 32)
$form.Controls.Add($title)

$sub = New-Object Windows.Forms.Label
$sub.Text = 'QQ 智能体运行控制台'
$sub.ForeColor = [Drawing.Color]::Gray
$sub.Location = New-Object Drawing.Point(20, 44)
$sub.Size = New-Object Drawing.Size(240, 18)
$form.Controls.Add($sub)

$group = New-Object Windows.Forms.GroupBox
$group.Text = '服务状态'
$group.Location = New-Object Drawing.Point(16, 70)
$group.Size = New-Object Drawing.Size(438, 190)
$form.Controls.Add($group)

$rows = @(
    @{ key = 'agent';   name = 'Agent 主进程';  hint = '3081' },
    @{ key = 'napcat';  name = 'NapCat / OneBot'; hint = '3001' },
    @{ key = 'proxy';   name = '语音代理';      hint = '3910' },
    @{ key = 'studio';  name = 'VoiceStudio';   hint = '3900' },
    @{ key = 'online';  name = 'QQ 真在线';     hint = 'watchdog' }
)

$script:StatusLabels = @{}
$y = 26
foreach ($r in $rows) {
    $dot = New-Object Windows.Forms.Panel
    $dot.Location = New-Object Drawing.Point(16, ($y + 4))
    $dot.Size = New-Object Drawing.Size(10, 10)
    $dot.BackColor = [Drawing.Color]::LightGray
    $group.Controls.Add($dot)

    $label = New-Object Windows.Forms.Label
    $label.Text = $r.name
    $label.Location = New-Object Drawing.Point(34, $y)
    $label.Size = New-Object Drawing.Size(160, 20)
    $group.Controls.Add($label)

    $state = New-Object Windows.Forms.Label
    $state.Text = '检查中…'
    $state.Location = New-Object Drawing.Point(200, $y)
    $state.Size = New-Object Drawing.Size(190, 20)
    $group.Controls.Add($state)

    $script:StatusLabels[$r.key] = @{ dot = $dot; text = $state }
    $y += 30
}

$ops = New-Object Windows.Forms.GroupBox
$ops.Text = '操作'
$ops.Location = New-Object Drawing.Point(16, 270)
$ops.Size = New-Object Drawing.Size(438, 104)
$form.Controls.Add($ops)

function New-Button([string]$text, [int]$x, [int]$y, [scriptblock]$onClick) {
    $b = New-Object Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object Drawing.Point($x, $y)
    $b.Size = New-Object Drawing.Size(100, 30)
    $b.Add_Click($onClick)
    $ops.Controls.Add($b)
    return $b
}

New-Button '启动全部' 14 22 {
    if (Test-Port 3081) { [Windows.Forms.MessageBox]::Show('已经在运行了。', 'QQ Agent') | Out-Null; return }
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$Repo\start-all.cmd`"" -WorkingDirectory $Repo
} | Out-Null

New-Button '停止全部' 122 22 {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$Repo\stop-all.cmd`"" -WorkingDirectory $Repo
} | Out-Null

New-Button '管理面板' 230 22 {
    if (-not (Test-Port 3081)) { [Windows.Forms.MessageBox]::Show('Agent 没在运行，先点"启动全部"。', 'QQ Agent') | Out-Null; return }
    Start-Process 'http://127.0.0.1:3081'
} | Out-Null

New-Button '修复登录' 338 22 {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$Repo\repair-login.cmd`"" -WorkingDirectory $Repo
} | Out-Null

New-Button '打开日志' 14 60 {
    Start-Process explorer.exe (Join-Path $Repo 'logs')
} | Out-Null

New-Button '刷新' 122 60 { } | Out-Null

$footer = New-Object Windows.Forms.Label
$footer.Text = '关闭窗口不会停止机器人；停止请点"停止全部"。'
$footer.ForeColor = [Drawing.Color]::Gray
$footer.Location = New-Object Drawing.Point(16, 382)
$footer.Size = New-Object Drawing.Size(438, 20)
$form.Controls.Add($footer)

function Set-Row([string]$key, [string]$text, [string]$color) {
    $item = $script:StatusLabels[$key]
    if (-not $item) { return }
    $item.text.Text = $text
    $item.text.ForeColor = switch ($color) {
        'ok'   { [Drawing.Color]::FromArgb(22, 143, 63) }
        'warn' { [Drawing.Color]::FromArgb(190, 120, 0) }
        'bad'  { [Drawing.Color]::FromArgb(190, 40, 40) }
        default { [Drawing.Color]::Gray }
    }
    $item.dot.BackColor = switch ($color) {
        'ok'   { [Drawing.Color]::FromArgb(46, 204, 113) }
        'warn' { [Drawing.Color]::FromArgb(241, 196, 15) }
        'bad'  { [Drawing.Color]::FromArgb(231, 76, 60) }
        default { [Drawing.Color]::LightGray }
    }
}

function Update-Status {
    $agent = Get-AgentInfo

    if ($agent.up) {
        Set-Row 'agent' ("运行中 · {" + $agent.uptime + "}s") 'ok'
    } else {
        Set-Row 'agent' '未运行' 'bad'
    }

    if (Test-Port 3001) { Set-Row 'napcat' '已连接（3001）' 'ok' } else { Set-Row 'napcat' '未运行' 'bad' }
    if (Test-Port 3910) { Set-Row 'proxy' '运行中（3910）' 'ok' } else { Set-Row 'proxy' '未运行（语音会退化为文字）' 'warn' }
    if (Test-Port 3900) { Set-Row 'studio' '运行中（3900）' 'ok' } else { Set-Row 'studio' '未运行（本地音色不可用）' 'warn' }

    if (([datetime]::Now - $script:LastWatchdogAt).TotalSeconds -ge 25) {
        $script:LastWatchdog = Get-WatchdogLine
        $script:LastWatchdogAt = [datetime]::Now
    }
    $w = $script:LastWatchdog
    if ($w -match 'ONLINE') {
        Set-Row 'online' '在线（消息可达）' 'ok'
    } elseif ($w -match 'OFFLINE') {
        Set-Row 'online' '假在线：连接已断，需重新登录' 'warn'
    } elseif ($w -match 'DOWN') {
        Set-Row 'online' '无法检测（NapCat 未运行）' 'bad'
    } else {
        Set-Row 'online' '检测中…' 'gray'
    }
}

if ($SmokeTest) {
    Update-Status
    foreach ($k in $script:StatusLabels.Keys) {
        "{0,-8} {1}" -f $k, $script:StatusLabels[$k].text.Text
    }
    exit 0
}

$refresh = New-Object Windows.Forms.Button
# 「刷新」按钮的实际处理在这里绑定，避免闭包问题
($ops.Controls | Where-Object { $_.Text -eq '刷新' }).Add_Click({ Update-Status })

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Status })
$timer.Start()

$form.Add_Shown({ Update-Status })
[void]$form.ShowDialog()
