@echo off
cd /d "%~dp0"
node scripts/import-capital-plan.mjs capital-plan.json
if errorlevel 1 echo Verify Meridian is running and your capital-plan.json is in this folder.
pause
