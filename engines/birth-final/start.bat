@echo off
if not defined GEMINI_API_KEY (echo Set GEMINI_API_KEY securely before running.& exit /b 1)
title BDRIS Certificate Studio
cd /d "%~dp0"

REM ============================================================
REM  Gemini API key (shudhu "Auto Calculate" button-er jonno).
REM  Key na thakleo cholbe - captcha nije type korlei hobe.
REM  Notepad diye ei file khule niche key ta bosan.
REM ============================================================

echo.
echo  ===============================================
echo   BDRIS Certificate Studio chalche...
echo   Browser-e khulun: http://localhost:3000
echo   Bondho korte: ei window-te Ctrl+C
echo  ===============================================
echo.
node server.js
pause
