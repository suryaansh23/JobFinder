@echo off
setlocal
set "INSTALL_DIR=%~dp0.."
title JobFinder - Connect Google Sheets
"%INSTALL_DIR%\node\node.exe" "%INSTALL_DIR%\scripts\google-sheets-setup.js"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Setup did not complete. You can run this helper again later.
) else (
  echo Setup completed successfully.
)
pause
exit /b %RC%
