@echo off
cd /d "%~dp0"
node scripts/windows-autostart.mjs enable
if errorlevel 1 echo Omni startup setup failed. Review the message above.
pause
