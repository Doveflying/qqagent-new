@echo off
REM Keep this file ASCII with CRLF.
REM One-click launcher: voice boost proxy + agent + schedule loop.
setlocal EnableExtensions
cd /d "%~dp0"

REM Refuse to start a second instance. Two agents share OneBot and brain.db,
REM which causes double replies and "database is locked" errors.
netstat -ano | findstr "127.0.0.1:3081" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [X] QQ Agent is already running on port 3081.
  echo     Close that window first. Two instances fight over OneBot and the database.
  pause
  exit /b 1
)

REM Loudness proxy in front of the local VoiceStudio (exits quietly if port is taken).
start "" /min cmd /c "node scripts\voice-boost.mjs >> logs\voice-boost.log 2>&1"

REM Model schedule + speech backend check in its own minimized window.
start "" /min cmd /c "scripts\model-schedule-loop.cmd"

REM Agent in the foreground; this window is the agent console.
call "start.bat"

endlocal
