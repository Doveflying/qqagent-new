@echo off
REM Keep this file ASCII with CRLF.
REM Every 10 minutes: model time table, speech backend, self post, watchdog.
REM Started by start-all.cmd; stop-all.cmd finds it by title.
setlocal

REM Only one scheduler at a time. Each launcher starts one, so repeated starts
REM used to stack duplicates - and every duplicate ran self-post again.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$c=(Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'QQAgent-Scheduler' }).Count; if ($c -gt 0) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo [i] Scheduler already running, this duplicate exits.
  timeout /t 2 /nobreak >nul
  exit /b 0
)

title QQAgent-Scheduler
:loop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-schedule.ps1" -Apply >> "%~dp0..\logs\model-schedule.log" 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0speech-backend.ps1" -Apply >> "%~dp0..\logs\speech-backend.log" 2>&1
REM Obsidian ??? -> ???????????????????????????
node "%~dp0obsidian-sync.mjs" --import >> "%~dp0..\logs\obsidian.log" 2>&1
REM ???? -> ???????????????????
node "%~dp0obsidian-sync.mjs" --export >> "%~dp0..\logs\obsidian.log" 2>&1
node "%~dp0self-post.mjs" >> "%~dp0..\logs\self-post.log" 2>&1
node "%~dp0watchdog.mjs" >> "%~dp0..\logs\watchdog.log" 2>&1
timeout /t 600 /nobreak >nul
goto loop
