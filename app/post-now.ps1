# 手动发一条动态：调用 self-post.mjs --force，并把输出同时写入日志。
# 由 post-now.cmd 调用（控制台的「发动态」按钮）。
$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repo 'start-all.cmd'))) {
    $repo = 'C:\桌面图标\qwe\QQagent'
}

$script = Join-Path $repo 'scripts\self-post.mjs'
$log = Join-Path $repo 'logs\self-post-manual.log'

if (-not (Test-Path $script)) {
    Write-Host "[X] 找不到 $script"
    exit 2
}

$stamp = "[{0}] ---- manual post ----" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Add-Content -LiteralPath $log -Value $stamp -Encoding UTF8

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($candidate in @("$env:ProgramFiles\nodejs\node.exe", "C:\Program Files\nodejs\node.exe")) {
        if (Test-Path $candidate) { $node = $candidate; break }
    }
}
if (-not $node) {
    Write-Host "[X] 找不到 node.exe，请确认 Node.js 已安装并在 PATH 中"
    Add-Content -LiteralPath $log -Value "[X] node not found" -Encoding UTF8
    exit 3
}

$out = & $node $script --force 2>&1
$code = $LASTEXITCODE

foreach ($line in $out) {
    Write-Host $line
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

$tail = "[{0}] exit code = {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $code
Add-Content -LiteralPath $log -Value $tail -Encoding UTF8

Write-Host ''
if ($code -eq 0) {
    Write-Host '[OK] 已发送。日志：logs\self-post-manual.log' -ForegroundColor Green
} else {
    Write-Host "[X] 失败，退出码 $code。详细日志：logs\self-post-manual.log" -ForegroundColor Red
}
exit $code
