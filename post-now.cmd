@echo off
REM Keep this file ASCII with CRLF.
REM Manual "post now" entry used by the control panel button.
REM Output is written to logs\self-post-manual.log so failures are not lost.
title QQAgent-PostNow
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "app\post-now.ps1"
echo.
pause
