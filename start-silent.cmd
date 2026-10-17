@echo off
REM Keep this file ASCII with CRLF.
REM Silent launcher: same as start-all.cmd but without a console window,
REM so the bot keeps running even if you close things.
REM Started by start-silent.vbs. Stop with stop-all.cmd or the desktop stop icon.
setlocal EnableExtensions
cd /d "%~dp0"
title QQAgent-Silent

REM Already running? Do nothing (avoids double instances).
netstat -ano | findstr "127.0.0.1:3081" | findstr "LISTENING" >nul
if not errorlevel 1 exit /b 0

start "" /min cmd /c "scripts\voice-proxy.cmd"
start "" /min cmd /c "scripts\model-schedule-loop.cmd"

REM If NapCat is not logged in, run the repair flow visibly (it needs the QR scan).
REM The agent reconnects on its own once the login completes.
netstat -ano | findstr ":3001 " | findstr "LISTENING" >nul
if errorlevel 1 start "" cmd /c "????.cmd"

start "" /min cmd /c "scripts\open-panel.cmd"

node dist\src\index.js >> "logs\agent.console.log" 2>&1
