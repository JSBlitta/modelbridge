@echo off
setlocal

echo.
echo ============================================
echo  ModelBridge - Setup ^& Build
echo ============================================
echo.

:: Check Node is available
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    exit /b 1
)
echo [1/5] Node.js: OK

:: Install backend deps
echo [2/5] Installing backend dependencies...
echo      First run downloads a prebuilt native module (better-sqlite3).
echo      This can take a few minutes and needs access to registry.npmjs.org and github.com.
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo ERROR: npm install failed. If it hung for a long time:
    echo   - check network access to registry.npmjs.org and github.com
    echo   - try:  npm cache clean --force
    echo   - diagnose the hang with:  npm install --verbose
    echo.
    exit /b 1
)

:: Install frontend deps
echo [3/5] Installing frontend dependencies...
cd frontend
call npm install --no-audit --no-fund
if errorlevel 1 ( echo ERROR: frontend npm install failed. & cd .. & exit /b 1 )

:: Build frontend
echo [4/5] Building frontend...
call npm run build
if errorlevel 1 ( echo ERROR: frontend build failed. & cd .. & exit /b 1 )
cd ..

:: Check .env exists
echo [5/5] Checking .env...
if not exist .env (
    echo.
    echo NOTICE: .env not found - copying .env.example to .env
    copy .env.example .env >nul
    echo.
    echo ACTION REQUIRED: Open .env and fill in:
    echo   PRODUUZIT_REFRESH_TOKEN  -or-  PRODUUZIT_ADMIN_USERNAME + PRODUUZIT_ADMIN_PASSWORD
    echo   TRIMBLE_CLIENT_ID
    echo   TRIMBLE_CLIENT_SECRET
    echo   REPORTING_REFRESH_TOKEN  (optional - only for the reporting scheduler)
    echo.
    echo   Reporting scheduler also needs:  data\produuzit_api_frequentie.csv
    echo.
    echo Then run:  node_modules\.bin\tsx src\index.ts
) else (
    echo .env found.
    echo.
    echo ============================================
    echo  Setup complete. Start the app with:
    echo    npm start
    echo  Or install as a service:
    echo    See HOSTING.md
    echo ============================================
)

endlocal
