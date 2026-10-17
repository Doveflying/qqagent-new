@echo off
REM Keep this file ASCII with CRLF.
REM Stops everything started by start-all.cmd.
setlocal EnableExtensions
title QQAgent-Stop

echo Stopping QQ Agent...

REM 1. by window title (agent console, proxy, scheduler loop)
for %%t in ("QQAgent-Agent" "QQAgent-VoiceProxy" "QQAgent-Scheduler" "QQAgent-OpenPanel") do (
  taskkill /FI "WINDOWTITLE eq %%~t" /T /F >nul 2>&1
)

REM 2. by port, in case a window was closed or renamed but the process survived
for %%p in (3081 3910) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /T /F >nul 2>&1
  )
)

timeout /t 2 /nobreak >nul

set "ALIVE="
for %%p in (3081 3910) do (
  netstat -ano | findstr ":%%p " | findstr "LISTENING" >nul && set "ALIVE=1"
)

if defined ALIVE (
  echo [X] Something is still listening on 3081 or 3910.
  echo     Open Task Manager and end the remaining node.exe processes.
) else (
  echo [OK] Agent and voice proxy are stopped.
  echo      The bot QQ account is still online in NapCat; quit that QQ window to go fully offline.
)

echo.
if not defined QQ_AGENT_NO_PAUSE pause
