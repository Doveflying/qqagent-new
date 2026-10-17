@echo off
REM Keep this file ASCII with CRLF.
REM Makes sure NapCat (the OneBot side) is running and logged in.
REM
REM   1. port 3001 already listening  -> nothing to do
REM   2. otherwise start headless-napcat.bat and wait for 3001
REM   3. still not up after the wait  -> force a QR login via repair-login.ps1
setlocal EnableExtensions
title QQAgent-EnsureNapCat

set "NAPCAT=%~1"
if "%NAPCAT%"=="" set "NAPCAT=C:\napcat\headless-napcat.bat"

netstat -ano | findstr ":3001 " | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [i] NapCat already running.
  exit /b 0
)

if not exist "%NAPCAT%" (
  echo [X] NapCat launcher not found: %NAPCAT%
  exit /b 2
)

echo [i] NapCat is not running. Starting it...
REM Prefer the hidden .vbs launcher: it detaches from any console, so closing a
REM window does not take the QQ session down with it (that is what run-napcat.bat
REM does). Falls back to the .bat when no .vbs exists.
set "VBS="
for %%I in ("%NAPCAT%") do set "VBS=%%~dpIheadless-napcat.vbs"
if not exist "%VBS%" set "VBS=C:\napcat\headless-napcat.vbs"
if exist "%VBS%" (
  echo [i] Using hidden launcher: %VBS%
  start "" wscript.exe "%VBS%"
) else (
  start "NapCat" cmd /c ""%NAPCAT%""
)

call :wait 90
if not errorlevel 1 (
  echo [i] NapCat is up.
  exit /b 0
)

echo [.] Still not logged in after 90s, forcing a QR login...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0repair-login.ps1" -KillQQ
call :wait 120
if not errorlevel 1 (
  echo [i] NapCat logged in after re-scan.
  exit /b 0
)

echo [X] NapCat still not listening on 3001.
echo     Open the NapCat window and check for errors, or run repair-login.cmd manually.
exit /b 1

:wait
set /a _tries=0
set /a _max=%~1/2
:waitloop
netstat -ano | findstr ":3001 " | findstr "LISTENING" >nul && exit /b 0
set /a _tries+=1
if %_tries% geq %_max% exit /b 1
timeout /t 2 /nobreak >nul
goto waitloop
