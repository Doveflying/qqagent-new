<#
.SYNOPSIS
    修复 NapCat 登录状态：在"快速登录令牌失效、又不弹二维码"时，强制重新扫码。

.DESCRIPTION
    NapCat 的 headless-napcat.bat 行为是：
      - quick-login.txt 存在 → 用其中的 QQ 号做快速登录（-q），不显示二维码
      - 文件不存在        → 显示二维码等待扫码

    快速登录令牌过期时，QQ 可能既不登录也不出二维码，表现为"启动了但没登录"。
    本脚本会临时移走 quick-login.txt、用扫码模式重启 NapCat、把二维码弹给你，
    登录成功后再把 quick-login.txt 还原。

    只在 OneBot 端口（默认 3001）未监听时才动手，已登录时直接退出。
#>
[CmdletBinding()]
param(
    [int]$Port = 3001,
    [string]$NapCatDir = 'C:\napcat',
    [int]$QrTimeoutSec = 120,
    [int]$LoginTimeoutSec = 180,
    # 自动结束已存在的 QQ 进程再重启。启动器会传这个参数，单独运行默认不带，避免误杀。
    [switch]$KillQQ
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$m) { Write-Host $m }

function Test-Port([int]$p) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $p)
        $c.Close()
        return $true
    } catch { return $false }
}

$quickFile = Join-Path $NapCatDir 'quick-login.txt'
$quickBak = Join-Path $NapCatDir 'quick-login.txt.bak'
$qrFile = Join-Path $NapCatDir 'cache\qrcode.png'
$launcher = Join-Path $NapCatDir 'headless-napcat.bat'

# ---------- 1. 已经登录就不动 ----------
if (Test-Port $Port) {
    Write-Step "OneBot 端口 $Port 已在监听：机器人已经登录，无需修复。"
    exit 0
}

if (-not (Test-Path $launcher)) {
    Write-Error "找不到 $launcher，请确认 NapCat 安装路径（当前参数 -NapCatDir $NapCatDir）"
    exit 2
}

# ---------- 2. 检查 QQ 是否还挂着旧会话 ----------
$qq = Get-Process QQ -ErrorAction SilentlyContinue
if ($qq) {
    if ($KillQQ) {
        Write-Step "检测到 $($qq.Count) 个 QQ 进程，正在结束旧会话…"
        try {
            Stop-Process -Name QQ -Force -ErrorAction Stop
            Stop-Process -Name QQEX -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Step "结束 QQ 失败：$($_.Exception.Message)"
            Write-Step "请手动退出 QQ 后重新运行本脚本。"
            exit 3
        }
        Start-Sleep -Seconds 4
        Write-Step "旧会话已结束。"
    } else {
        Write-Step "检测到 $($qq.Count) 个 QQ 进程仍在运行。"
        Write-Step "旧的 QQ 会话必须先退出，否则新启动的实例会冲突。"
        Write-Step ""
        Write-Step "请先关闭 QQ（右下角托盘 → 退出），然后重新运行本脚本。"
        Write-Step "或者加 -KillQQ 参数让脚本自动结束它们。"
        exit 3
    }
}

# ---------- 3. 临时移走快速登录令牌，强制走扫码 ----------
$hadQuick = Test-Path $quickFile
if ($hadQuick) {
    if (Test-Path $quickBak) { Remove-Item $quickBak -Force }
    Move-Item $quickFile $quickBak
    Write-Step "已临时移走 quick-login.txt（快速登录令牌可能已过期），改为扫码登录。"
} else {
    Write-Step "没有 quick-login.txt，本来就应该出二维码。"
}

$qrBefore = if (Test-Path $qrFile) { (Get-Item $qrFile).LastWriteTimeUtc } else { [datetime]::MinValue }

# ---------- 4. 启动 NapCat（扫码模式） ----------
Write-Step "正在启动 NapCat…"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$launcher`"" -WorkingDirectory $NapCatDir

# ---------- 5. 等二维码出现 ----------
Write-Step "等待二维码生成（最多 $QrTimeoutSec 秒）…"
$deadline = (Get-Date).AddSeconds($QrTimeoutSec)
$qrReady = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    if (Test-Path $qrFile) {
        $m = (Get-Item $qrFile).LastWriteTimeUtc
        if ($m -gt $qrBefore) { $qrReady = $true; break }
    }
}
if ($qrReady) {
    Start-Process $qrFile
    Write-Step "二维码已弹出，请用手机 QQ 扫码登录机器人账号。"
} else {
    Write-Step "没等到新的二维码。请切到 NapCat 的窗口看看有没有报错，或手动运行："
    Write-Step "  $launcher"
}

# ---------- 6. 等登录完成 ----------
Write-Step "等待登录完成（最多 $LoginTimeoutSec 秒）…"
$deadline = (Get-Date).AddSeconds($LoginTimeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Port $Port) {
        Write-Step "登录成功，OneBot 端口 $Port 已就绪。"
        if ($hadQuick -and (Test-Path $quickBak)) {
            Move-Item $quickBak $quickFile -Force
            Write-Step "已还原 quick-login.txt（下次启动仍走快速登录）。"
            Write-Step "如果你希望以后每次都扫码，删掉这个文件即可：$quickFile"
        }
        exit 0
    }
}

Write-Step "等待超时，仍未检测到登录。"
Write-Step "如果二维码窗口已经消失，重新运行本脚本一次；多次失败请在 QQ 登录界面手动选择账号密码登录。"
if ($hadQuick -and (Test-Path $quickBak)) {
    Move-Item $quickBak $quickFile -Force
    Write-Step "已还原 quick-login.txt。"
}
exit 4
