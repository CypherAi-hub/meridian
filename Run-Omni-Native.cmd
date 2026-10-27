@echo off
setlocal
cd /d "%~dp0"
set "action=%~1"
if "%action%"=="" set "action=start"
if "%action%"=="start" goto run
if "%action%"=="status" goto run
if "%action%"=="autostart-enable" goto run
if "%action%"=="autostart-disable" goto run
echo Usage: Run-Omni-Native.cmd [start^|status^|autostart-enable^|autostart-disable]
exit /b 2
:run
set "OMNI_NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto launch
set "OMNI_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%OMNI_NODE%" goto launch
echo Node.js 24 is required. Existing databases and settings have not been changed.
exit /b 1
:launch
"%OMNI_NODE%" "%~dp0scripts\native-windows.mjs" "%action%"
exit /b %errorlevel%
