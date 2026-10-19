@echo off
cd /d %~dp0
echo ============================================
echo   Death Verify - dependency install (idempotent)
echo ============================================

echo.
echo [1/4] Node.js check...
where node >nul 2>&1
if errorlevel 1 (
    echo   node nei - winget diye install hocche...
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
) else (
    for /f "delims=" %%v in ('node --version') do echo   node OK: %%v
)

echo.
echo [2/4] Python check...
where python >nul 2>&1
if errorlevel 1 (
    echo   python nei - winget diye install hocche...
    winget install -e --id Python.Python.3.14 --accept-package-agreements --accept-source-agreements
    if errorlevel 1 winget install -e --id Python.Python.3.13 --accept-package-agreements --accept-source-agreements
) else (
    for /f "delims=" %%v in ('python --version 2^>^&1') do echo   python OK: %%v
)

echo.
echo [3/4] Solver deps (opencv-python + ddddocr)...
python -c "import cv2" >nul 2>&1
if errorlevel 1 (
    echo   cv2 nei - pip install opencv-python...
    python -m pip install --upgrade opencv-python
) else (
    echo   cv2 OK
)
python -c "import ddddocr" >nul 2>&1
if errorlevel 1 (
    echo   ddddocr nei - pip install ddddocr...
    python -m pip install --upgrade ddddocr
) else (
    echo   ddddocr OK
)

echo.
echo [4/4] Local solver verify...
python -c "import solve_local" >nul 2>&1
if errorlevel 1 (
    echo   solve_local import FAIL - uporer deps gulo check koren
) else (
    echo   solve_local.py OK
)

echo.
echo ============================================
echo   Shob thik hole: start-verify.bat chalun.
echo   (port 3001 already thakle shudhu browser khule dey)
echo ============================================
pause
