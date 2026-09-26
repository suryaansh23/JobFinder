@echo off
REM JobFinder unattended server launcher. No browser window is opened by this script.
setlocal EnableDelayedExpansion

set "INSTALL_DIR=%~dp0.."
set "JOBFINDER_DATA=%APPDATA%\JobFinder"
if not exist "%JOBFINDER_DATA%" mkdir "%JOBFINDER_DATA%"
if not exist "%JOBFINDER_DATA%\data" mkdir "%JOBFINDER_DATA%\data"
if not exist "%JOBFINDER_DATA%\lib" mkdir "%JOBFINDER_DATA%\lib"
copy /Y "%INSTALL_DIR%\app\lib\toolbar.src.js" "%JOBFINDER_DATA%\lib\toolbar.src.js" >nul 2>nul

REM Optional local AI. Start Ollama only when it is installed and not already healthy.
set "OLLAMA_EXE="
where ollama >nul 2>nul && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if defined OLLAMA_EXE (
    powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:11434/api/tags -TimeoutSec 2).StatusCode } catch { 0 }" > "%TEMP%\jobfinder_ollama_watchdog.txt" 2>nul
    set /p OLLAMA_STATUS=<"%TEMP%\jobfinder_ollama_watchdog.txt"
    del "%TEMP%\jobfinder_ollama_watchdog.txt" >nul 2>nul
    if not "!OLLAMA_STATUS!"=="200" (
        start "Ollama" /min "!OLLAMA_EXE!" serve
        timeout /t 3 /nobreak >nul
    )
)

REM Load user-specific runtime settings without putting secrets inside the install folder.
if exist "%JOBFINDER_DATA%\JobFinder.env.cmd" call "%JOBFINDER_DATA%\JobFinder.env.cmd"

set "PORT=3737"
set "HOSTNAME=127.0.0.1"
set "NODE_PATH=%INSTALL_DIR%\app\node_modules"

cd /d "%JOBFINDER_DATA%"
"%INSTALL_DIR%\node\node.exe" "%INSTALL_DIR%\app\server.js"

endlocal
