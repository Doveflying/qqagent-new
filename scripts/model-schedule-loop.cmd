@echo off
REM Keep this file ASCII with CRLF.
REM Every 10 minutes: re-check the model time table and the speech backend.
REM Started by start-all.cmd; stop-all.cmd finds this window by its title.
title QQAgent-Scheduler
setlocal
:loop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-schedule.ps1" -Apply >> "%~dp0..\logs\model-schedule.log" 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0speech-backend.ps1" -Apply >> "%~dp0..\logs\speech-backend.log" 2>&1
node "%~dp0self-post.mjs" >> "%~dp0..\logs\self-post.log" 2>&1
node "%~dp0watchdog.mjs" >> "%~dp0..\logs\watchdog.log" 2>&1
timeout /t 600 /nobreak >nul
goto loop
