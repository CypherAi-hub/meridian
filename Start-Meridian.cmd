@echo off
cd /d "%~dp0"
node scripts/selfhost.mjs init
if errorlevel 1 goto failed
node scripts/selfhost.mjs up
if errorlevel 1 goto failed
start "" http://localhost:8080
pause
exit /b 0
:failed
echo Meridian command failed. Verify Node.js and Docker Desktop are installed and Docker is running.
pause
exit /b 1
