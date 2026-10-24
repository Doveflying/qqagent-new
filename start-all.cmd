@echo off
REM Keep this file ASCII with CRLF.
REM One-click launcher: NapCat -> voice proxy -> schedule loop -> panel -> agent.
setlocal EnableExtensions
cd /d "%~dp0"
title QQAgent-Agent

if not exist "runtime" mkdir "runtime" >nul 2>&1
set "LOCK=%~dp0runtime\agent.lock"

REM ---- single instance, part 1: port ----
netstat -ano | findstr "127.0.0.1:3081" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [X] QQ Agent is already running on port 3081.
  echo     Run stop-all.cmd first.
  pause
  exit /b 1
)

REM ---- single instance, part 2: lock dir ----
REM Two launches within a few seconds used to slip past the port check,
REM because the first agent had not bound 3081 yet. mkdir is atomic, so
REM exactly one launcher wins here.
REM A lock younger than 2 minutes counts as live; an older one is stale
REM (left behind by a crash) and gets cleared.
if exist "%LOCK%" (
  powershell -NoProfile -Command "if ((Get-Item -LiteralPath '%LOCK%').LastWriteTime -lt (Get-Date).AddSeconds(-120)) { exit 0 } else { exit 1 }"
  if errorlevel 1 (
    echo [X] Another launcher is already starting QQ Agent.
    echo     Wait a few seconds, then open http://127.0.0.1:3081
    pause
    exit /b 1
  )
  rmdir "%LOCK%" 2>nul
)
mkdir "%LOCK%" 2>nul
if errorlevel 1 (
  echo [X] Another launcher is already starting QQ Agent.
  pause
  exit /b 1
)

REM ---- bring up NapCat first ----
call "scripts\ensure-napcat.cmd"

start "" /min cmd /c "scripts\voice-proxy.cmd"
start "" /min cmd /c "scripts\model-schedule-loop.cmd"
start "" /min cmd /c "scripts\open-panel.cmd"
REM ---- rebuild when src is newer than dist ----
REM start-all prefers the compiled dist, so a src change that was never built
REM serves stale code: the panel HTML is read per request, but API routes are
REM registered at startup, so new routes 404 while the new page still renders.
set "NEEDBUILD="
if not exist "dist\src\index.js" set "NEEDBUILD=1"
if exist "dist\src\index.js" (
  node "scripts\needs-build.mjs" >nul 2>&1
  if errorlevel 1 set "NEEDBUILD=1"
)
if defined NEEDBUILD call "scripts\ensure-build.cmd"

REM Agent in the foreground; this window is the agent console.
REM Prefer the compiled output: it starts faster and does not depend on the
REM esbuild service that tsx needs. Fall back to npm start (tsx) on a fresh
REM clone where dist has not been built yet.
if exist "dist\src\index.js" (
  node "dist\src\index.js"
) else (
  echo [i] dist\src\index.js not found, falling back to npm start ...
  call "start.bat"
)

set "EXITCODE=%ERRORLEVEL%"
rmdir "%LOCK%" 2>nul

echo.
echo ============================================================
echo   Agent exited with code %EXITCODE%
echo   Time: %DATE% %TIME%
echo ============================================================
>> "logs\start-all.log" echo [%DATE% %TIME%] agent exited with code %EXITCODE%
if not defined QQ_AGENT_NO_PAUSE pause

endlocal
