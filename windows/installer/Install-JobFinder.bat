@echo off
REM ============================================================================
REM JobFinder - one-click installer for Windows 10/11
REM
REM Double-click this file. No admin rights, no toolchain, nothing to compile.
REM
REM It installs to %LOCALAPPDATA%\Programs\JobFinder, which is the same place
REM VS Code and Ollama use for a per-user install. That choice is deliberate:
REM Program Files needs elevation, and elevation on a downloaded file is exactly
REM the prompt people are told not to click through.
REM ============================================================================
setlocal EnableDelayedExpansion
title JobFinder Setup
color 0B

set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\Programs\JobFinder"
set "DESKTOP=%USERPROFILE%\Desktop"
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"

echo.
echo   ===========================================================
echo     JobFinder Setup
echo   ===========================================================
echo.
echo   Installs to: %DEST%
echo   No administrator rights required.
echo.

REM --- sanity: are we next to the payload? ------------------------------------
if not exist "%SRC%app\server.js" (
    echo   [X] This installer must stay in the same folder as the "app" directory.
    echo       Extract the whole ZIP, then run this file from inside it.
    echo.
    pause
    exit /b 1
)

REM --- 1. copy the application ------------------------------------------------
echo   [1/5] Copying files...
if exist "%DEST%" (
    echo         Existing install found - updating in place.
    echo         Your data in %%APPDATA%%\JobFinder is left untouched.
)
if not exist "%DEST%" mkdir "%DEST%" 2>nul
robocopy "%SRC%app"     "%DEST%\app"     /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul
robocopy "%SRC%node"    "%DEST%\node"    /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul
robocopy "%SRC%scripts" "%DEST%\scripts" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul
if exist "%SRC%README.txt" copy /Y "%SRC%README.txt" "%DEST%\README.txt" >nul 2>nul
REM robocopy uses exit codes 0-7 for success; 8+ is a genuine failure.
if %ERRORLEVEL% GEQ 8 (
    echo   [X] Copy failed. Is the destination in use? Close JobFinder and retry.
    pause
    exit /b 1
)
echo         Done.

REM --- 2. shortcuts -----------------------------------------------------------
echo   [2/5] Creating shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w=New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @('%DESKTOP%','%STARTMENU%')) {" ^
  "  if (-not (Test-Path $dir)) { continue }" ^
  "  $s=$w.CreateShortcut((Join-Path $dir 'JobFinder.lnk'));" ^
  "  $s.TargetPath='%DEST%\scripts\launcher.bat';" ^
  "  $s.WorkingDirectory='%DEST%';" ^
  "  $s.IconLocation='%DEST%\app\public\favicon.ico,0';" ^
  "  $s.Description='JobFinder - local job application assistant';" ^
  "  $s.Save() }" >nul 2>nul
if exist "%DESKTOP%\JobFinder.lnk" (echo         Desktop icon created.) else (echo         [!] Desktop shortcut could not be created.)

REM --- 3. Ollama --------------------------------------------------------------
echo.
echo   [3/5] Local AI engine ^(Ollama^)
set "OLLAMA_EXE="
where ollama >nul 2>nul && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if defined OLLAMA_EXE (
    echo         Ollama is already installed - reusing it.
) else (
    echo.
    echo         Ollama runs the AI locally. Without it JobFinder still scans jobs,
    echo         scores fit, fills forms from your answer bank and tracks applications
    echo         - you lose AI drafting, cover letters and interview prep.
    echo.
    set /p "GETOLLAMA=        Download and install Ollama now? (~200 MB) [Y/n]: "
    if /I "!GETOLLAMA!"=="n" (
        echo         Skipped. Install later from https://ollama.com/download
    ) else (
        echo         Downloading Ollama...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
          "try { Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile \"$env:TEMP\OllamaSetup.exe\" -UseBasicParsing; Start-Process -Wait -FilePath \"$env:TEMP\OllamaSetup.exe\" -ArgumentList '/SILENT' } catch { Write-Host ('        Download failed: ' + $_.Exception.Message) }"
        where ollama >nul 2>nul && set "OLLAMA_EXE=ollama"
        if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
    )
)

REM --- 4. models --------------------------------------------------------------
echo.
echo   [4/5] AI models
if not defined OLLAMA_EXE (
    echo         Ollama not available - skipping models.
    echo         Once you install it, run:  ollama pull qwen2.5:7b-instruct
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\scripts\post-install-models.ps1"
)

REM --- 5. unattended 24x7 mode -------------------------------------------------
echo.
echo   [5/5] 24x7 watchdog and power settings
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\scripts\configure-power-24x7.ps1" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\scripts\install-24x7.ps1"
if errorlevel 1 (
    echo         [!] Could not register the 24x7 watchdog. JobFinder can still be
    echo             started from the Desktop shortcut; rerun install-24x7.ps1 later.
) else (
    echo         24x7 watchdog enabled for this Windows user.
)

REM --- done -------------------------------------------------------------------
echo.
echo   ===========================================================
echo     Installed.
echo   ===========================================================
echo.
echo     Desktop icon : JobFinder
echo     Installed to : %DEST%
echo     Your data    : %APPDATA%\JobFinder   ^(kept across updates^)
echo     24x7 mode    : enabled at Windows logon
echo.
set /p "OPENNOW=  Open the JobFinder dashboard now? [Y/n]: "
if /I not "!OPENNOW!"=="n" (
    timeout /t 3 /nobreak >nul
    start "" http://127.0.0.1:3737
)

endlocal
