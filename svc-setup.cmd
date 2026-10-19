@echo off
REM Keep this file ASCII with CRLF.
REM One-time setup for zero-shot singing voice conversion (Seed-VC).
REM
REM   .\\svc-env\\           Python virtual env (torch + deps)
REM   tools\\seed-vc\\       upstream repo
REM
REM Run this once. It downloads several GB; keep the window open.
setlocal EnableExtensions
cd /d "%~dp0.."
title QQAgent-SVC-Setup

set "ENV=.svc-env"
set "REPO_DIR=tools\seed-vc"

echo ============================================================
echo  QQ Agent - singing voice conversion setup (Seed-VC)
echo ============================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [X] python not found in PATH.
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

REM venv may lack pip when ensurepip is blocked; bootstrap it if needed.
"%PY%" -m pip --version >nul 2>&1
if errorlevel 1 (
  echo [2/5] bootstrapping pip ...
  "%PY%" -m ensurepip --upgrade
)

echo [3/5] installing torch (CUDA 12.1 build, ~2.5 GB) ...
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
if errorlevel 1 (
  echo [X] torch install failed. Check network / proxy.
  pause
  exit /b 1
)

if not exist "%REPO_DIR%\.git" (
  echo [4/5] cloning Seed-VC ...
  where git >nul 2>&1
  if errorlevel 1 (
    echo [X] git not found. Install Git or clone manually into %REPO_DIR%
    pause
    exit /b 1
  )
  git clone --depth 1 https://github.com/Plachtaa/seed-vc "%REPO_DIR%"
  if errorlevel 1 (
    echo [X] clone failed.
    pause
    exit /b 1
  )
) else (
  echo [4/5] Seed-VC already cloned.
)

echo [5/5] installing Seed-VC requirements ...
"%PY%" -m pip install -r "%REPO_DIR%\requirements.txt"
if errorlevel 1 (
  echo [!] requirements install returned an error; check the output above.
)

echo.
echo ============================================================
echo  Done. Next:
echo    - put a clean vocal clip of HER voice here:  refs\voice.wav  (10-30s)
echo    - put the song vocal you want to convert:    refs\song.wav
echo    - run svc-convert.cmd
echo ============================================================
pause
