@echo off
REM ============================================================================
REM JobFinder launcher - what the Desktop and Start Menu shortcuts run.
REM Installed at C:\Program Files\JobFinder\scripts\launcher.bat
REM ============================================================================
setlocal EnableDelayedExpansion

title JobFinder

REM %~dp0 ends with a backslash; strip the trailing "scripts\" to reach the root.
set "INSTALL_DIR=%~dp0.."

REM ---------------------------------------------------------------------------
REM Working directory
REM
REM The app resolves BOTH its data and lib\toolbar.src.js from process.cwd().
REM Program Files is not writable by a standard user, so cwd has to be %APPDATA% -
REM but that means the toolbar source would not be found there. Copying that one
REM file across on each start keeps it correct after an upgrade too.
REM ---------------------------------------------------------------------------
set "JOBFINDER_DATA=%APPDATA%\JobFinder"
if not exist "%JOBFINDER_DATA%"      mkdir "%JOBFINDER_DATA%"
if not exist "%JOBFINDER_DATA%\data" mkdir "%JOBFINDER_DATA%\data"
if not exist "%JOBFINDER_DATA%\lib"  mkdir "%JOBFINDER_DATA%\lib"
copy /Y "%INSTALL_DIR%\app\lib\toolbar.src.js" "%JOBFINDER_DATA%\lib\toolbar.src.js" >nul 2>nul

REM Load user-specific runtime settings without putting secrets inside the install folder.
if exist "%JOBFINDER_DATA%\JobFinder.env.cmd" call "%JOBFINDER_DATA%\JobFinder.env.cmd"

REM ---------------------------------------------------------------------------
REM Ollama - optional. JobFinder runs without it; only the AI features go quiet.
REM ---------------------------------------------------------------------------
set "OLLAMA_EXE="
where ollama >nul 2>nul && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if not defined OLLAMA_EXE (
    echo [JobFinder] Ollama not found. Scanning, fit scoring, the answer bank and the
    echo             tracker all still work; AI drafting and interview prep will not.
    echo             Install from https://ollama.com/download to enable them.
    echo.
) else (
    REM Delayed expansion matters here: without it %OLLAMA_STATUS% is substituted when
    REM the whole parenthesised block is PARSED, i.e. before set /p has run, so the
    REM check always compared an empty string and started a duplicate server.
    powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:11434/api/tags -TimeoutSec 2).StatusCode } catch { 0 }" > "%TEMP%\jobfinder_ollama.txt" 2>nul
    set /p OLLAMA_STATUS=<"%TEMP%\jobfinder_ollama.txt"
    del "%TEMP%\jobfinder_ollama.txt" >nul 2>nul
    if not "!OLLAMA_STATUS!"=="200" (
        echo [JobFinder] Starting Ollama in the background...
        start "Ollama" /min "!OLLAMA_EXE!" serve
        timeout /t 3 /nobreak >nul
    ) else (
        echo [JobFinder] Ollama is already running.
    )
)

REM ---------------------------------------------------------------------------
REM Chrome - required for scanning and autofill.
REM ---------------------------------------------------------------------------
set "CHROME_FOUND="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe"      set "CHROME_FOUND=1"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_FOUND=1"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"      set "CHROME_FOUND=1"
if not defined CHROME_FOUND (
    echo [JobFinder] Google Chrome was not found. Scanning and autofill need it.
    echo             Install from https://www.google.com/chrome/ then restart JobFinder.
    echo.
)

cd /d "%JOBFINDER_DATA%"

set "PORT=3737"
set "HOSTNAME=127.0.0.1"
set "NODE_PATH=%INSTALL_DIR%\app\node_modules"
REM Read by the packaged server.js: Next chdir()s to its own folder on startup,
REM so this is what actually keeps the database out of the install directory.
set "JOBFINDER_DATA=%JOBFINDER_DATA%"

REM Open the dashboard once the server has had a moment to bind the port.
start "" /min cmd /c "timeout /t 4 /nobreak >nul && start http://127.0.0.1:3737"

echo [JobFinder] Starting on http://127.0.0.1:3737
echo [JobFinder] Close this window to stop the server.
echo.

"%INSTALL_DIR%\node\node.exe" "%INSTALL_DIR%\app\server.js"

REM If node exits immediately something is wrong - hold the window so the error is
REM readable instead of a console that flashes and disappears.
if errorlevel 1 (
    echo.
    echo [JobFinder] The server exited with an error. The message above explains why.
    pause
)

endlocal
