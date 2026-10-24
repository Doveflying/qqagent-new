@echo off
REM Keep this file ASCII with CRLF.
REM Rebuild dist when src is newer than the compiled output.
REM Called by start-all.cmd. Never fails the launch: on any problem we keep the
REM existing dist and let the agent start with what is already there.
setlocal EnableExtensions
cd /d "%~dp0.."

echo [i] Source is newer than dist - rebuilding...
set "NPMPATH="
for /f "delims=" %%i in ('where npm.cmd 2^>nul') do if not defined NPMPATH set "NPMPATH=%%i"
if not defined NPMPATH if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPMPATH=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPMPATH (
  echo [!] npm not found - starting with the existing dist.
  exit /b 0
)
call "%NPMPATH%" run build
if errorlevel 1 echo [!] Build failed - starting with the existing dist anyway.
exit /b 0
