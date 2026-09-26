JobFinder for Windows
=====================

INSTALL
-------
  1. Right-click JobFinder-Windows.zip -> Extract All
  2. Open the extracted "windows" folder
  3. Double-click  Install-JobFinder.bat

That is the whole install. No administrator rights are needed - JobFinder goes into
%LOCALAPPDATA%\Programs\JobFinder, the same place VS Code and Ollama use for a
per-user install.

The installer will:
  * copy the app and a bundled Node.js runtime (nothing to install separately)
  * put a JobFinder icon on your Desktop and in the Start Menu
  * offer to install Ollama, and skip it if you already have it
  * set up the AI models, and skip any that are already downloaded

Windows SmartScreen may warn about an unrecognised app because this installer is not
code-signed. Choose "More info" -> "Run anyway". You can read Install-JobFinder.bat in
Notepad first - it is a plain text script.


WHAT YOU NEED
-------------
  Windows 10 or 11 (64-bit)          required
  Google Chrome                      required - scanning and autofill drive real Chrome
  Ollama + a model                   optional - only the AI features need it

Without Ollama you still get: job scanning across 21 sources, fit scoring against your
CV, the answer bank, autofill from saved answers, the pipeline tracker and the contacts
directory. You lose AI drafting, cover letters and interview prep.


RUNNING IT
----------
Double-click the JobFinder icon. A console window opens (that is the server - leave it
open) and your browser opens http://127.0.0.1:3737.

To stop JobFinder, close the console window.


WHERE YOUR THINGS LIVE
----------------------
  Program   %LOCALAPPDATA%\Programs\JobFinder
  Your data %APPDATA%\JobFinder

Your data is deliberately kept out of the program folder, so reinstalling or updating
never touches your CV, answers, applications or saved logins.


UNINSTALL
---------
Delete %LOCALAPPDATA%\Programs\JobFinder and the Desktop and Start Menu shortcuts.
Your data in %APPDATA%\JobFinder is left alone - delete that too if you want it gone.


TROUBLESHOOTING
---------------
The console window flashes and vanishes
  Run Install-JobFinder.bat again; the copy may have been incomplete.

"Google Chrome was not found"
  Install Chrome from https://www.google.com/chrome/ and restart JobFinder.

The browser opens but the page will not load
  Give it a few more seconds on first run, then refresh. If port 3737 is already in
  use by something else, close that program.

AI features are quiet
  Check Ollama is running: open a terminal and run  ollama list
  If the command is not found, install from https://ollama.com/download


PRIVACY
-------
Everything runs on your machine. There is no account and no server. Your CV, answers,
cookies and database never leave the computer. Full details in README.md and
USER_MANUAL.md in the project repository.

GOOGLE SHEETS MASTER TRACKER
----------------------------
JobFinder can use a Google Sheet as its master queue and remote intervention channel.

Run:
    scripts\configure-google-sheets.bat

You need a Google OAuth "Desktop app" client ID and client secret once. The helper
opens Google sign-in, captures the authorization locally, validates the Automation
Queue + Interventions tabs, and stores the refresh token in:

    %APPDATA%\JobFinder\JobFinder.env.cmd

That file stays outside the install folder and is preserved across upgrades.

