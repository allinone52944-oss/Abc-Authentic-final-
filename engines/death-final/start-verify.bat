@echo off
if not defined GEMINI_API_KEY (echo Set GEMINI_API_KEY securely before running.& exit /b 1)
cd /d %~dp0
REM  idempotent: port 3001 already LISTENING hole? shudhu browser khul, server abar na chalao.
netstat -ano | findstr "LISTENING" | findstr ":3001 " >nul 2>&1
if not errorlevel 1 (
    echo [start-verify] Server already chalache port 3001-e - browser khulchi...
    start "" http://localhost:3001
    exit /b 0
)
REM  Gemini API key (shudhu "Auto Calculate" fallback-er jonno; local solver e lagena).
start "" http://localhost:3001
node death-verify-server.js
