@echo off
setlocal

echo.
echo ============================================
echo  ModelBridge - Tests ^& Typecheck
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 echo ERROR: Node.js not found. Install from https://nodejs.org & exit /b 1
if not exist node_modules echo ERROR: dependencies not installed. Run setup.bat first. & exit /b 1

set FAILED=

:: Each step is a flat statement pair. Nesting these inside if-blocks would make
:: cmd expand %FAILED% at parse time and always read the value it had on entry.

echo [1/3] Typechecking backend...
call npx tsc --noEmit
if errorlevel 1 set FAILED=1
if errorlevel 1 echo    FAILED: typecheck

echo.
echo [2/3] Backend tests...
call npm test
if errorlevel 1 set FAILED=1
if errorlevel 1 echo    FAILED: backend tests

echo.
echo [3/3] Frontend tests...
if not exist frontend\node_modules goto :nofrontend
pushd frontend
call npm test
if errorlevel 1 set FAILED=1
if errorlevel 1 echo    FAILED: frontend tests
popd
goto :done

:nofrontend
echo    SKIPPED: frontend dependencies not installed. Run setup.bat first.

:done
echo.
echo ============================================
if defined FAILED echo  RESULT: FAILURES - see output above
if defined FAILED exit /b 1
echo  RESULT: all checks passed
echo ============================================

endlocal
