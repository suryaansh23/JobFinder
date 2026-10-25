@echo off
setlocal
set "INSTALL_DIR=%~dp0.."
title JobFinder - Permanent Google Sheets Connection
"%INSTALL_DIR%\node\node.exe" "%INSTALL_DIR%\scripts\google-service-account-setup.js"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Setup did not complete. Your previous Google Sheets configuration was kept.
) else (
  echo Service-account setup completed successfully.
)
pause
exit /b %RC%
