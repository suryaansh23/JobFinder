@echo off
setlocal
title JobFinder - Consolidated Update
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Update-JobFinder.ps1" -Source "%~dp0."
if errorlevel 1 (
  echo.
  echo Update needs attention. The previous installation has been retained where possible.
  pause
  exit /b 1
)
echo.
call "%LOCALAPPDATA%\Programs\JobFinder\scripts\24x7-control.bat" --autopilot
exit /b %ERRORLEVEL%
