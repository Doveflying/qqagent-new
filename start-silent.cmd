@echo off
REM Keep this file ASCII with CRLF.
REM Silent launcher: no console window, so the bot cannot be stopped by accident.
REM Started by start-silent.vbs. Stop with stop-all.cmd or the desktop stop icon.
setlocal EnableExtensions
cd /d "%~dp0"
title QQAgent-Silent

if not exist "runtime" mkdir "runtime" >nul 2>&1
set "LOCK=%~dp0runtime\agent.lock"

REM Already serving? Nothing to do.
netstat -ano | findstr "127.0.0.1:3081" | findstr "LISTENING" >nul
if not errorlevel 1 exit /b 0

REM Atomic lock: two quick double-clicks can no longer start two agents.
REM A lock younger than 2 minutes counts as live; an older one is stale and cleared.
if exist "%LOCK%" (
  powershell -NoProfile -Command "if ((Get-Item -LiteralPath '%LOCK%').LastWriteTime -lt (Get-Date).AddSeconds(-120)) { exit 0 } else { exit 1 }"
  if errorlevel 1 exit /b 0
  rmdir "%LOCK%" 2>nul
)
mkdir "%LOCK%" 2>nul
if errorlevel 1 exit /b 0

REM Bring up NapCat (starts QQ if needed; opens a window when a QR scan is required).
call "scripts\ensure-napcat.cmd"

start "" /min cmd /c "scripts\voice-proxy.cmd"
start "" /min cmd /c "scripts\model-schedule-loop.cmd"
start "" /min cmd /c "scripts\open-panel.cmd"

node dist\src\index.js >> "logs\agent.console.log" 2>&1

rmdir "%LOCK%" 2>nul
exit /b 0
