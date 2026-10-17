@echo off
REM Keep this file ASCII with CRLF.
REM Fixes "started but not logged in" / "logged in but the QQ kernel is dead".
REM
REM   repair-login.cmd         -> keeps QQ, cleans the quick-login token, shows QR
REM   repair-login.cmd force   -> closes QQ first, then shows QR (for a wedged session)
title QQAgent-RepairLogin
cd /d "%~dp0"

if /i "%~1"=="force" (
  echo [i] Force mode: closing QQ before re-login...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\repair-login.ps1" -KillQQ
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\repair-login.ps1"
)
echo.
pause
