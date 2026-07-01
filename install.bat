@echo off
chcp 65001 >nul
color 0C

cls
echo.
echo   ██████╗ ██╗  ██╗ █████╗ ██████╗  █████╗ ███╗   ██╗██╗
echo   ██╔══██╗██║  ██║██╔══██╗██╔══██╗██╔══██╗████╗  ██║██║
echo   ██║  ██║███████║███████║██████╔╝███████║██╔██╗ ██║██║
echo   ██║  ██║██╔══██║██╔══██║██╔══██╗██╔══██║██║╚██╗██║██║
echo   ██████╔╝██║  ██║██║  ██║██║  ██║██║  ██║██║ ╚████║██║
echo   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝
echo.
echo         DHARANI.OS — Task Intelligence Installer
echo   -------------------------------------------------
echo.

:: ── Step 1: Check Node.js ──────────────────────────
echo   [1/4] Checking Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo         ERROR: Node.js not found!
    echo         Install from: https://nodejs.org
    echo         After installing, run this script again.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo         OK  Node.js %NODE_VER% found

:: ── Step 2: Check npm ─────────────────────────────
echo   [2/4] Checking npm...
npm -v >nul 2>&1
if %errorlevel% neq 0 (
    echo         ERROR: npm not found!
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('npm -v') do set NPM_VER=%%i
echo         OK  npm v%NPM_VER% found

:: ── Step 3: Install packages ──────────────────────
echo.
echo   [3/4] Installing packages (takes ~1 min)...
echo         Please wait...
echo.

call npm install --legacy-peer-deps

if %errorlevel% neq 0 (
    echo.
    echo         ERROR: npm install failed!
    echo         Try: npm install --force
    pause
    exit /b 1
)

echo.
echo         OK  All packages installed!

:: ── Step 4: .env check ────────────────────────────
echo.
echo   [4/4] Checking .env file...

if not exist ".env" (
    echo REACT_APP_ANTHROPIC_API_KEY=your_api_key_here> .env
    echo         Created .env file
) else (
    echo         .env file already exists
)

findstr /c:"your_api_key_here" .env >nul 2>&1
if %errorlevel% equ 0 (
    echo.
    echo   WARNING: API KEY NOT SET YET
    echo   Open .env and replace:
    echo   REACT_APP_ANTHROPIC_API_KEY=your_api_key_here
    echo   with your real key from:
    echo   https://console.anthropic.com
    echo.
)

:: ── Open VS Code ──────────────────────────────────
echo   -------------------------------------------------
echo.
where code >nul 2>&1
if %errorlevel% equ 0 (
    echo   OK  Opening in VS Code...
    start code .
    timeout /t 2 >nul
) else (
    echo   NOTE: VS Code CLI not found.
    echo   Open VS Code manually and open this folder.
)

:: ── Start dev server ──────────────────────────────
echo.
echo   OK  Starting dev server...
echo   --> App opens at: http://localhost:3000
echo.
echo   -------------------------------------------------
echo   Press Ctrl+C to stop the server
echo   -------------------------------------------------
echo.

npm start
