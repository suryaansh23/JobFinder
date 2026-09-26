@echo off
setlocal
set "INSTALL_DIR=%~dp0.."
title JobFinder - 24x7 Control
"%INSTALL_DIR%\node\node.exe" "%INSTALL_DIR%\scripts\24x7-control.js"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
