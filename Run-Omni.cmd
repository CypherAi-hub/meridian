@echo off
cd /d "%~dp0"
node scripts/selfhost.mjs init
if errorlevel 1 goto failed
node scripts/selfhost.mjs collect
if errorlevel 1 goto failed
start "" http://localhost:8080
pause
exit /b 0
:failed
echo Omni could not start. Open Docker Desktop and verify Node.js 22 or newer is installed.
pause
exit /b 1
