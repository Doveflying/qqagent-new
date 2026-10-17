@echo off
REM Keep this file ASCII with CRLF.
REM One-click launcher: voice proxy + schedule loop + agent, then open the panel.
setlocal EnableExtensions
cd /d "%~dp0"
title QQAgent-Agent

REM Refuse to start a second instance. Two agents share OneBot and brain.db,
REM which causes double replies and "database is locked" errors.
netstat -ano | findstr "127.0.0.1:3081" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [X] QQ Agent is already running on port 3081.
  echo     Run stop-all.cmd first. Two instances fight over OneBot and the database.
  pause
  exit /b 1
)

REM Loudness/translation proxy in front of the local VoiceStudio (own titled window).
start "" /min cmd /c "scripts\voice-proxy.cmd"

REM Model schedule + speech backend check in its own minimized window.
start "" /min cmd /c "scripts\model-schedule-loop.cmd"

REM Open the admin panel in the default browser once it is listening.
start "" /min cmd /c "scripts\open-panel.cmd"

REM Agent in the foreground; this window is the agent console.
call "start.bat"

endlocal
