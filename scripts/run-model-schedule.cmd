@echo off
setlocal
set "LOG=%~dp0..\logs\model-schedule.log"
echo [%DATE% %TIME%] ---- run ---- >> "%LOG%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-schedule.ps1" -Apply >> "%LOG%" 2>&1
endlocal
