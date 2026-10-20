# Pack a deployable bundle for the cloud server (excludes node_modules, models, audio)
#
#   powershell -File deploy/pack.ps1
#
# Output: QQagent\qqagent-deploy.tar.gz (a few MB, includes brain.db)
# Uses bsdtar because Compress-Archive writes backslash paths that Linux unzip
# turns into literal filenames.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo 'qqagent-deploy.tar.gz'
$stage = Join-Path $env:TEMP ('qqagent-pack-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

$include = @('src', 'scripts', 'deploy', 'config', 'data', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', '.gitignore')
$excludeDirs = @('node_modules', 'tools', '.svc-env', '.svc-tmp', 'refs', 'outputs', 'logs', 'runtime', 'app', '.git', '.npm-cache', '.piptest')
$excludeFiles = @('config\*.state.json', 'config\*.local.json', 'config\roleplay.json', 'data\*.bak')

New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($item in $include) {
  $src = Join-Path $repo $item
  if (-not (Test-Path $src)) { Write-Host "skip (missing): $item"; continue }
  Copy-Item $src -Destination $stage -Recurse -Force
  Write-Host "add: $item"
}
foreach ($dir in $excludeDirs) {
  Get-ChildItem -Path $stage -Recurse -Directory -Filter $dir -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
}
foreach ($glob in $excludeFiles) {
  Get-ChildItem -Path (Join-Path $stage $glob) -ErrorAction SilentlyContinue | Remove-Item -Force
}
# brain.db WAL/SHM are runtime files; shipping them can make the copy inconsistent
Get-ChildItem -Path (Join-Path $stage 'data') -Filter 'brain.db-*' -ErrorAction SilentlyContinue | Remove-Item -Force

if (Test-Path $out) { Remove-Item $out -Force }
& tar -czf $out -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
Remove-Item $stage -Recurse -Force

$size = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host ""
Write-Host "done: $out ($size MB)" -ForegroundColor Green
Write-Host "upload with: scp `"$out`" root@SERVER_IP:/root/"
