@echo off
REM Keep this file ASCII with CRLF.
REM Fixes "started but not logged in": forces a fresh QR login when the
REM NapCat quick-login token has expired.
title QQAgent-RepairLogin
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\repair-login.ps1"
echo.
pause
