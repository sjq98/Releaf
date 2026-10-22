@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "PORT=5174"
title Releaf Server - Port 5174
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed or is not on PATH.
    goto :failed
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo npm.cmd was not found. Please reinstall Node.js with npm.
    goto :failed
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);"
if errorlevel 1 (
    echo Node.js 22.13.0 or later is required.
    goto :failed
)

node -e "for (const name of Object.keys(require('./package.json').dependencies)) { try { require.resolve(name); } catch { process.exit(1); } }"
if errorlevel 1 (
    echo Installing project dependencies...
    call npm.cmd ci
    if errorlevel 1 goto :failed
)

echo Starting Releaf at http://127.0.0.1:5174
echo Press Ctrl+C to stop the server.
echo.
call npm.cmd start
if errorlevel 1 goto :failed

popd
exit /b 0

:failed
echo.
echo Startup failed. Check the message above.
pause
popd
exit /b 1
