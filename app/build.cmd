@echo off
REM Keep this file ASCII with CRLF.
REM Rebuilds app\QQAgent.exe from app\QQAgent.cs using the .NET Framework compiler.
REM Run this after editing QQAgent.cs.
setlocal
cd /d "%~dp0.."

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [X] csc.exe not found. .NET Framework 4.x is required.
  pause
  exit /b 1
)

echo Building app\QQAgent.exe ...
"%CSC%" /nologo /target:winexe /codepage:65001 /optimize+ /out:app\QQAgent.exe ^
  /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll ^
  /reference:System.Core.dll app\QQAgent.cs

if errorlevel 1 (
  echo [X] Build failed.
  pause
  exit /b 1
)

echo [OK] app\QQAgent.exe rebuilt.
exit /b 0
