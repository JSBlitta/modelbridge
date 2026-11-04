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
set NODEMAJOR=0
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
:: better-sqlite3 ships prebuilt Windows binaries only for these majors. Any
:: other version falls back to compiling from source, which needs Python and
:: Visual Studio build tools and fails on a plain machine.
set NODEOK=0
for %%m in (22 24 25 26) do if "%NODEMAJOR%"=="%%m" set NODEOK=1
if "%NODEOK%"=="0" (
    echo ERROR: Node 22, 24, 25 or 26 is required ^(prebuilt better-sqlite3^). Found:
    node -v
    exit /b 1
)
echo [1/6] Node.js: OK

:: Install backend deps
echo [2/6] Installing backend dependencies...
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

:: Unpacking a release over this folder never deletes files, so move out any
:: code file this release no longer contains (see scripts\prune-stale.ts).
echo      Checking for files left over from earlier releases...
call node_modules\.bin\tsx scripts\prune-stale.ts
if errorlevel 1 ( echo ERROR: could not move leftover files out of src. & exit /b 1 )

:: Install frontend deps
echo [3/6] Installing frontend dependencies...
cd frontend
call npm install --no-audit --no-fund
if errorlevel 1 ( echo ERROR: frontend npm install failed. & cd .. & exit /b 1 )

:: Build frontend
echo [4/6] Building frontend...
call npm run build
if errorlevel 1 ( echo ERROR: frontend build failed. & cd .. & exit /b 1 )
cd ..
if not exist frontend-dist\index.html (
    echo ERROR: build reported success but frontend-dist\index.html is missing.
    echo        The server serves that folder, so the app would load blank.
    exit /b 1
)

echo [5/6] Typecheck ^& tests...
call npx tsc --noEmit
if errorlevel 1 ( echo ERROR: typecheck failed. & exit /b 1 )
call npm test
if errorlevel 1 ( echo ERROR: tests failed. & exit /b 1 )

:: Check .env exists
echo [6/6] Checking .env...
if not exist .env (
    echo.
    echo NOTICE: .env not found - copying .env.example to .env
    copy .env.example .env >nul
    echo.
    echo ACTION REQUIRED: Open .env and fill in:
    echo   PRODUUZIT_REFRESH_TOKEN  -or-  PRODUUZIT_ADMIN_USERNAME + PRODUUZIT_ADMIN_PASSWORD
    echo   TRIMBLE_CLIENT_ID
    echo   TRIMBLE_CLIENT_SECRET
    echo   ADMIN_USERNAMES          who may open the admin page - leave it empty
    echo                            and nobody can, including you
    echo   REPORTING_REFRESH_TOKEN  (optional - only for the reporting scheduler)
    echo.
    echo   Reporting scheduler also needs:  data\produuzit_api_frequentie.csv
    echo.
    echo   Every /api route now requires a login. Users sign in with their own
    echo   Produuzit account; the app itself talks to Produuzit with the single
    echo   service token above.
    echo.
    echo Then run:  node_modules\.bin\tsx src\index.ts
) else (
    echo .env found.
    echo.
    echo ============================================
    echo  Setup complete. Start the app with:
    echo    npm start
    echo  Re-run checks any time with:
    echo    tests.bat
    echo  Or install as a service:
    echo    See HOSTING.md
    echo ============================================
)

endlocal
