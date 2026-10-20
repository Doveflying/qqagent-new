# 把本地 .sh 脚本送到服务器执行
#
#   powershell -File deploy/run-remote.ps1 deploy/_check.sh
#
# 为什么要 base64：从 PowerShell 直接拼 ssh 命令行时，双引号会被 Windows
# 的参数解析吃掉，远端 bash 拿到的是被剥了引号的命令（踩过两次）。

param(
  [Parameter(Mandatory = $true)][string]$Script,
  [string]$Server = 'root@39.106.128.9'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$path = Resolve-Path (Join-Path $repo $Script)
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))

$ssh = @(
  '-i', (Join-Path $repo '.ssh\id_ed25519'),
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=NUL',
  '-o', 'ConnectTimeout=10'
)

$remote = "echo $b64 | base64 -d > /root/_run.sh && bash /root/_run.sh"
& ssh @ssh $Server $remote
exit $LASTEXITCODE
