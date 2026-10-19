@echo off
REM Keep this file ASCII with CRLF.
REM One-time setup for zero-shot singing voice conversion (Seed-VC).
REM
REM   .svc-env\          Python virtual env (torch + deps)
REM   tools\seed-vc\     upstream repo
REM   .svc-tmp\          pip cache/temp kept inside the project
REM
REM Run this once by double-clicking. Several GB will be downloaded.
setlocal EnableExtensions
cd /d "%~dp0"
title QQAgent-SVC-Setup

set "ENV=.svc-env"
set "REPO_DIR=tools\seed-vc"
set "MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple"

REM Keep pip temp/cache inside the project: some sandboxes and AV products
REM deny writes to %LOCALAPPDATA% or to paths containing non-ASCII characters.
set "PIP_CACHE_DIR=%CD%\.svc-tmp\cache"
set "TMP=%CD%\.svc-tmp\tmp"
set "TEMP=%CD%\.svc-tmp\tmp"
if not exist "%PIP_CACHE_DIR%" mkdir "%PIP_CACHE_DIR%"
if not exist "%TMP%" mkdir "%TMP%"

echo ============================================================
echo  QQ Agent - singing voice conversion setup (Seed-VC)
echo ============================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [X] python not found in PATH. Install Python 3.10-3.12 first.
  pause
  exit /b 1
)

if not exist "%ENV%\Scripts\python.exe" (
  echo [1/5] creating virtual env ...
  python -m venv "%ENV%"
  if not exist "%ENV%\Scripts\python.exe" (
    echo [X] venv creation failed.
    pause
    exit /b 1
  )
) else (
  echo [1/5] virtual env already exists, reusing.
)

set "PY=%ENV%\Scripts\python.exe"

"%PY%" -m pip --version >nul 2>&1
if errorlevel 1 (
  echo [2/5] bootstrapping pip ...
  "%PY%" -m ensurepip --upgrade
)

echo [3/5] installing torch ...
"%PY%" -m pip install --upgrade pip -i %MIRROR%
echo      - trying CUDA 12.1 build first (better on the RTX 5060)
"%PY%" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
if errorlevel 1 (
  echo      - CUDA build failed, falling back to CPU build from the mirror
  "%PY%" -m pip install torch torchaudio -i %MIRROR%
  if errorlevel 1 (
    echo [X] torch install failed. Check network or proxy settings.
    pause
    exit /b 1
  )
)

if not exist "%REPO_DIR%\.git" (
  echo [4/5] cloning Seed-VC ...
  where git >nul 2>&1
  if errorlevel 1 (
    echo [X] git not found. Install Git, or clone manually into %REPO_DIR%
    pause
    exit /b 1
  )
  git clone --depth 1 https://github.com/Plachtaa/seed-vc "%REPO_DIR%"
  if errorlevel 1 (
    echo [X] clone failed. Retry with a proxy, or clone into %REPO_DIR% manually.
    pause
    exit /b 1
  )
) else (
  echo [4/5] Seed-VC already cloned.
)

echo [5/5] installing Seed-VC requirements ...
"%PY%" -m pip install -r "%REPO_DIR%\requirements.txt" -i %MIRROR%
if errorlevel 1 (
  echo [!] requirements install returned an error; read the output above.
)

echo.
echo ============================================================
echo  Done. Next:
echo    1. put a clean 10-30s clip of HER voice at: refs\voice.wav
echo    2. put the song vocal you want to convert at: refs\song.wav
echo    3. tell the agent, it will run the conversion
echo ============================================================
pause
