@echo off
REM Keep this file ASCII with CRLF.
REM Loudness/translation proxy in its own titled window (stop-all.cmd finds it by title).
title QQAgent-VoiceProxy
cd /d "%~dp0.."
node scripts\voice-boost.mjs >> logs\voice-boost.log 2>&1
