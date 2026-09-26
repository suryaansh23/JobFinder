#!/usr/bin/env node
/* eslint-disable no-console */
// Build the standalone JobFinder desktop app for macOS and Windows.
//
//   node desktop/build.js            both platforms
//   node desktop/build.js mac        just macOS
//   node desktop/build.js win        just Windows
//
// Output:
//   desktop/dist/mac/JobFinder.app          double-click on macOS
//   desktop/dist/win/JobFinder/             folder for Windows, plus a .zip
//
// WHAT GOES IN
//   Electron shell            the window; no browser chrome, no localhost URL to type
//   app/                      the Next.js server, already compiled and minified
//   runtime/node              the Node that runs it, so nothing is assumed about the machine
//   chromium/                 the browser used for searching and applying
//
// ON READABILITY
// The production Next build already compiles every route and library into minified
// chunks with the comments gone, which is where the reasoning lives. This script closes
// the one remaining gap — lib/toolbar.src.js, which is read from disk at runtime — and
// seals everything into an asar archive so the package does not present as a folder of
// source files. That stops casual reading. It is not protection against someone
// determined: JavaScript that runs on a machine can always be recovered, and anyone who
// tells you otherwise is selling something.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HERE = __dirname;
const OUT = path.join(HERE, 'dist');
const STAGE = path.join(OUT, '.stage');

const ELECTRON_VERSION = '31.7.7';
const NODE_VERSION = 'v20.18.0';
const APP_NAME = 'JobFinder';

const want = process.argv[2];
const TARGETS = want === 'mac' ? ['mac'] : want === 'win' ? ['win'] : ['mac', 'win'];

let stepN = 0;
const step = (m) => console.log(`\n[${++stepN}] ${m}`);
const ok = (m) => console.log(`    ✓ ${m}`);
const warn = (m) => console.log(`    ⚠ ${m}`);

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

function copyDir(src, dst, skip = () => false) {
  mkdir(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (skip(s, e)) continue;
    if (e.isSymbolicLink()) {
      const link = fs.readlinkSync(s);
      try { fs.symlinkSync(link, d); } catch { /* already there */ }
    } else if (e.isDirectory()) {
      copyDir(s, d, skip);
    } else {
      fs.copyFileSync(s, d);
      // Preserve the executable bit — Chromium and node are useless without it.
      try { fs.chmodSync(d, fs.statSync(s).mode); } catch { /* best effort */ }
    }
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    mkdir(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    let lastPct = -1;
    const get = (u, n = 0) => https.get(u, { headers: { 'user-agent': 'JobFinder-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (n > 5) return reject(new Error('too many redirects'));
        res.resume();
        return get(res.headers.location, n + 1);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      const total = Number(res.headers['content-length']) || 0;
      let seen = 0;
      res.on('data', (c) => {
        seen += c.length;
        const pct = total ? Math.floor((seen / total) * 100) : 0;
        if (total && pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`    …${pct}%\r`); }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => { process.stdout.write('           \r'); resolve(dest); }));
    }).on('error', reject);
    get(url);
  });
}

// ── 1. The application server ───────────────────────────────────────────────

// Scripts that are INJECTED INTO PAGES keep their comments through every minifier,
// because they live inside template literals — to a minifier they are just strings.
//
// That is where the most revealing reasoning in the project sits: why a honeypot must
// never be filled, how a machine-written value is distinguished from a typed one, which
// escape sequences the template eats. Three such comment blocks survived into the
// packaged build.
//
// Full minification of those strings would mean unescaping them, minifying, and
// re-escaping — and the escaping in these files is delicate enough to have caused three
// separate bugs already. Stripping whole comment LINES changes no code at all, cannot
// alter an escape sequence, and removes exactly the thing worth hiding.
const EMBEDS = ['lib/observer.js', 'lib/browser.js'];

function stripEmbeddedComments() {
  const saved = new Map();
  for (const rel of EMBEDS) {
    const file = path.join(ROOT, rel);
    const src = fs.readFileSync(file, 'utf8');
    saved.set(file, src);
    let removed = 0;
    const out = src.split('\n').filter((line) => {
      // Only whole-line comments. A trailing comment could sit after code containing a
      // string with "//" in it (every https:// URL), and no build should be guessing.
      if (/^\s*\/\/(?!\/)/.test(line)) { removed++; return false; }
      return true;
    }).join('\n');
    fs.writeFileSync(file, out);
    ok(`${rel}: ${removed} comment line(s) stripped for the build`);
  }

  // Prove the stripped observer still works before anything is built on top of it.
  //
  // This transform edits a file whose escaping has already caused three separate bugs,
  // and a broken observer does not fail loudly — it fails by silently detecting no form
  // fields at all, which would ship as "autofill does nothing" on someone else's
  // machine. The existing guard catches exactly that, so it runs here too.
  try {
    execSync('node scripts/test-observer-escaping.mjs', { cwd: ROOT, stdio: 'pipe' });
    ok('stripped page scripts still parse and keep their escapes');
  } catch (e) {
    restoreSources(saved);
    throw new Error(`stripping comments broke the injected page scripts:\n${e.stdout?.toString() || e.message}`);
  }
  return saved;
}

function restoreSources(saved) {
  for (const [file, src] of saved) fs.writeFileSync(file, src);
}

function buildServer() {
  step('Compiling the application (Next.js standalone)');
  // data/ is moved aside first: Next's file tracer follows it and would copy the whole
  // browser-session store into the build. That produced a 12 GB output once.
  //
  // Moving a live directory aside is the dangerous part of this script, so it is done
  // defensively. Anything still running — a scan browser, a scheduled run — keeps
  // writing to ./data and recreates it, and a plain rename back then fails with
  // ENOTEMPTY. The recovery must never be "delete what is in the way": that is the
  // user's database.
  const dataDir = path.join(ROOT, 'data');
  const parked = path.join(ROOT, `.data-parked-${Date.now()}`);
  const hasData = fs.existsSync(dataDir);
  if (hasData) fs.renameSync(dataDir, parked);
  const saved = stripEmbeddedComments();
  try {
    execSync('npx next build', {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        JOBFINDER_STANDALONE: '1',
        NODE_ENV: 'production',
        // Anything that touches the database during the build writes here instead of
        // recreating ./data underneath us.
        JOBFINDER_DATA: path.join(require('node:os').tmpdir(), `jobfinder-build-${Date.now()}`),
      },
    });
  } finally {
    // Always, even if the build threw — leaving the working tree stripped of its
    // comments would be a far worse outcome than a failed build.
    restoreSources(saved);
    if (hasData) restoreData(dataDir, parked);
  }
  ok('compiled');
}

/**
 * Put the real data directory back, whatever happened while it was away.
 *
 * If something recreated ./data during the build it is set aside with a warning rather
 * than deleted — it may contain a screenshot or a browser profile written seconds ago,
 * and no build script should be in the business of throwing away user files.
 */
function restoreData(dataDir, parked) {
  if (fs.existsSync(dataDir)) {
    const residue = path.join(ROOT, `.data-build-residue-${Date.now()}`);
    fs.renameSync(dataDir, residue);
    warn(`something wrote to data/ during the build; kept at ${path.basename(residue)}`);
  }
  fs.renameSync(parked, dataDir);
}

function stageApp() {
  step('Staging the compiled server');
  const app = path.join(STAGE, 'app');
  rm(app);
  copyDir(path.join(ROOT, '.next/standalone'), app);
  // Next leaves these out of standalone on purpose; without them the UI has no CSS.
  copyDir(path.join(ROOT, '.next/static'), path.join(app, '.next/static'));
  if (fs.existsSync(path.join(ROOT, 'public'))) {
    copyDir(path.join(ROOT, 'public'), path.join(app, 'public'));
  }

  // The one file that is read from disk at runtime, so it never went through the
  // compiler. Minify it here rather than shipping commented source.
  const toolbar = path.join(app, 'lib/toolbar.src.js');
  if (fs.existsSync(toolbar)) {
    try {
      execSync(`npx esbuild "${toolbar}" --minify --outfile="${toolbar}.min" --log-level=error`, { cwd: ROOT });
      fs.renameSync(`${toolbar}.min`, toolbar);
      ok('runtime-loaded script minified');
    } catch (e) {
      warn(`could not minify toolbar.src.js (${e.message.split('\n')[0]}) — shipping as-is`);
    }
  }

  // Nothing here should carry a licence header pointing at the project, or a source map
  // that would undo the compilation.
  let maps = 0;
  (function stripMaps(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stripMaps(p);
      else if (e.name.endsWith('.map')) { fs.rmSync(p); maps++; }
    }
  })(app);
  if (maps) ok(`${maps} source map(s) removed`);

  const size = execSync(`du -sh "${app}" | cut -f1`).toString().trim();
  ok(`server staged (${size})`);
}

function stageElectronMain() {
  step('Bundling the desktop shell');
  const dst = path.join(STAGE, 'shell');
  rm(dst); mkdir(dst);
  // esbuild flattens main.js + setup.js into one minified CommonJS file. Electron loads
  // exactly one file and there is nothing else in the archive to read.
  execSync(
    `npx esbuild "${path.join(HERE, 'main/main.js')}" --bundle --platform=node --target=node20 `
    + `--external:electron --minify --outfile="${path.join(dst, 'main.js')}" --log-level=error`,
    { cwd: ROOT }
  );
  fs.writeFileSync(path.join(dst, 'package.json'), JSON.stringify({
    name: 'jobfinder',
    productName: APP_NAME,
    version: require(path.join(ROOT, 'package.json')).version || '1.0.0',
    main: 'main.js',
  }, null, 2));
  ok('shell bundled');
}

// ── 2. Runtimes ─────────────────────────────────────────────────────────────

// The Node that runs the server, and the one native module that has to match it.
//
// Both platforms get the SAME Node version, downloaded from nodejs.org, because the
// build machine's own Node cannot be shipped: it is dynamically linked against
// libnode.dylib and dies with "Library not loaded" the moment it is copied out of its
// install. The official tarballs are self-contained.
//
// Pinning the version pins the ABI, and the ABI is what better-sqlite3's compiled
// binary is built against. Ship Node 20 (ABI 115) and you must ship the ABI-115
// better-sqlite3 for the target platform — the one installed here is a macOS arm64
// binary built for whatever Node this machine runs, and it is useless on Windows and
// wrong even on another Mac if the versions differ.
const NODE_ABI = '115';   // must match NODE_VERSION above

async function stageNode(platform) {
  const dir = path.join(STAGE, `runtime-${platform}`);
  const exe = platform === 'win' ? 'node.exe' : 'node';
  if (fs.existsSync(path.join(dir, exe))) { ok(`node runtime already staged (${platform})`); return dir; }
  mkdir(dir);

  if (platform === 'win') {
    const zip = path.join(STAGE, `node-win-${NODE_VERSION}.zip`);
    if (!fs.existsSync(zip)) {
      console.log('    downloading Node for Windows…');
      await download(`https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`, zip);
    }
    execSync(`unzip -q -o "${zip}" -d "${STAGE}/node-win"`);
    fs.copyFileSync(path.join(STAGE, `node-win/node-${NODE_VERSION}-win-x64/node.exe`), path.join(dir, exe));
  } else {
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    const tgz = path.join(STAGE, `node-mac-${NODE_VERSION}-${arch}.tar.gz`);
    if (!fs.existsSync(tgz)) {
      console.log('    downloading Node for macOS…');
      await download(`https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${arch}.tar.gz`, tgz);
    }
    execSync(`tar -xzf "${tgz}" -C "${STAGE}"`);
    fs.copyFileSync(path.join(STAGE, `node-${NODE_VERSION}-darwin-${arch}/bin/node`), path.join(dir, exe));
    fs.chmodSync(path.join(dir, exe), 0o755);
  }
  ok(`node ${NODE_VERSION} staged for ${platform}`);
  return dir;
}

/**
 * Replace the compiled better-sqlite3 with the build for this platform and ABI.
 *
 * Without this the macOS binary travels to Windows, the app starts, and the very first
 * database call throws — which surfaces as a blank window on someone else's machine
 * with no clue why.
 */
async function swapSqlite(appDir, platform) {
  const target = platform === 'win' ? 'win32-x64' : `darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}`;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/better-sqlite3/package.json'), 'utf8'));
  const tgz = path.join(STAGE, `better-sqlite3-${pkg.version}-${NODE_ABI}-${target}.tar.gz`);
  if (!fs.existsSync(tgz)) {
    console.log(`    downloading better-sqlite3 for ${target}…`);
    await download(
      `https://github.com/WiseLibs/better-sqlite3/releases/download/v${pkg.version}`
      + `/better-sqlite3-v${pkg.version}-node-v${NODE_ABI}-${target}.tar.gz`,
      tgz
    );
  }
  const dest = path.join(appDir, 'node_modules/better-sqlite3');
  if (!fs.existsSync(dest)) throw new Error('better-sqlite3 missing from the staged app');
  const tmp = path.join(STAGE, `bsq-${target}`);
  rm(tmp); mkdir(tmp);
  execSync(`tar -xzf "${tgz}" -C "${tmp}"`);
  const built = path.join(tmp, 'build/Release/better_sqlite3.node');
  if (!fs.existsSync(built)) throw new Error('prebuilt better_sqlite3.node not found in the archive');
  mkdir(path.join(dest, 'build/Release'));
  fs.copyFileSync(built, path.join(dest, 'build/Release/better_sqlite3.node'));
  ok(`better-sqlite3 swapped to ${target} (ABI ${NODE_ABI})`);
}

async function stageElectron(platform) {
  const tag = platform === 'mac' ? 'darwin-arm64' : 'win32-x64';
  const dir = path.join(STAGE, `electron-${tag}`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) { ok(`electron ${tag} already staged`); return dir; }
  const zip = path.join(STAGE, `electron-${tag}.zip`);
  if (!fs.existsSync(zip)) {
    console.log(`    downloading Electron ${ELECTRON_VERSION} (${tag})…`);
    await download(
      `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-${tag}.zip`,
      zip
    );
  }
  mkdir(dir);
  execSync(`unzip -q -o "${zip}" -d "${dir}"`);
  ok(`electron ${tag} staged`);
  return dir;
}

async function stageChromium(platform) {
  const dir = path.join(STAGE, `chromium-${platform}`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) { ok(`chromium ${platform} already staged`); return dir; }

  if (platform === 'mac') {
    // Reuse the Chromium Playwright already downloaded for this machine.
    const cache = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
    const found = fs.existsSync(cache)
      ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop()
      : null;
    if (!found) { warn('no Playwright Chromium found — run `npx playwright install chromium`'); return null; }
    mkdir(dir);
    copyDir(path.join(cache, found), dir);
    ok(`chromium staged from ${found}`);
    return dir;
  }

  // Windows Chromium has to come from Playwright's CDN, since this machine is a Mac.
  const revision = readChromiumRevision();
  if (!revision) { warn('could not determine the Chromium revision — Windows build will have no browser'); return null; }
  const zip = path.join(STAGE, `chromium-win-${revision}.zip`);
  if (!fs.existsSync(zip)) {
    console.log(`    downloading Chromium ${revision} for Windows…`);
    await download(`https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-win64.zip`, zip)
      .catch(async () => download(`https://playwright.azureedge.net/builds/chromium/${revision}/chromium-win64.zip`, zip));
  }
  mkdir(dir);
  execSync(`unzip -q -o "${zip}" -d "${dir}"`);
  ok('chromium staged for Windows');
  return dir;
}

/** The Chromium build Playwright expects, read from the installed package. */
function readChromiumRevision() {
  for (const pkg of ['playwright-core', 'rebrowser-playwright-core']) {
    try {
      const p = path.join(ROOT, 'node_modules', pkg, 'browsers.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const c = (j.browsers || []).find((b) => b.name === 'chromium');
      if (c?.revision) return c.revision;
    } catch { /* try the next one */ }
  }
  return null;
}

// ── 3. Assembly ─────────────────────────────────────────────────────────────

function packAsar(resourcesDir) {
  const shell = path.join(STAGE, 'shell');
  try {
    execSync(`npx --yes @electron/asar pack "${shell}" "${path.join(resourcesDir, 'app.asar')}"`, { cwd: ROOT });
    ok('shell sealed into app.asar');
  } catch (e) {
    warn(`asar packing failed (${e.message.split('\n')[0]}) — copying the shell unpacked`);
    copyDir(shell, path.join(resourcesDir, 'app'));
  }
}

async function buildMac() {
  step('Assembling the macOS app');
  const electronDir = await stageElectron('mac');
  const outDir = path.join(OUT, 'mac');
  rm(outDir); mkdir(outDir);

  const appPath = path.join(outDir, `${APP_NAME}.app`);
  copyDir(path.join(electronDir, 'Electron.app'), appPath);

  const contents = path.join(appPath, 'Contents');
  const resources = path.join(contents, 'Resources');

  // Rename the executable so the process, the Dock and Force Quit all say JobFinder.
  fs.renameSync(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS', APP_NAME));
  fs.chmodSync(path.join(contents, 'MacOS', APP_NAME), 0o755);

  const plist = path.join(contents, 'Info.plist');
  let xml = fs.readFileSync(plist, 'utf8');
  xml = xml
    .replace(/<key>CFBundleExecutable<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleExecutable</key><string>${APP_NAME}</string>`)
    .replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleName</key><string>${APP_NAME}</string>`)
    .replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleDisplayName</key><string>${APP_NAME}</string>`)
    .replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIdentifier</key><string>com.jobfinder.desktop</string>');
  fs.writeFileSync(plist, xml);

  rm(path.join(resources, 'default_app.asar'));
  packAsar(resources);
  copyDir(path.join(STAGE, 'app'), path.join(resources, 'app'));
  await swapSqlite(path.join(resources, 'app'), 'mac');
  copyDir(await stageNode('mac'), path.join(resources, 'runtime'));
  const chrome = await stageChromium('mac');
  if (chrome) copyDir(chrome, path.join(resources, 'chromium'));

  // An unsigned app copied from another machine is quarantined by Gatekeeper. Ad-hoc
  // signing does not remove that, but it does stop the "damaged and should be moved to
  // the Bin" dialog, which is the one that looks like a virus warning.
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'ignore' });
    ok('ad-hoc signed');
  } catch { warn('ad-hoc signing failed — the first launch will need right-click → Open'); }

  const size = execSync(`du -sh "${appPath}" | cut -f1`).toString().trim();
  ok(`${APP_NAME}.app built (${size})`);
  return appPath;
}

async function buildWin() {
  step('Assembling the Windows app');
  const electronDir = await stageElectron('win');
  const outDir = path.join(OUT, 'win');
  rm(outDir);
  const appDir = path.join(outDir, APP_NAME);
  mkdir(appDir);
  copyDir(electronDir, appDir);

  fs.renameSync(path.join(appDir, 'electron.exe'), path.join(appDir, `${APP_NAME}.exe`));

  const resources = path.join(appDir, 'resources');
  rm(path.join(resources, 'default_app.asar'));
  packAsar(resources);
  copyDir(path.join(STAGE, 'app'), path.join(resources, 'app'));
  await swapSqlite(path.join(resources, 'app'), 'win');
  copyDir(await stageNode('win'), path.join(resources, 'runtime'));
  const chrome = await stageChromium('win');
  if (chrome) copyDir(chrome, path.join(resources, 'chromium'));

  // A real install, without needing an installer toolchain.
  //
  // Inno Setup and friends only run on Windows, and this builds on a Mac. A .bat that
  // copies the folder into %LOCALAPPDATA% and makes shortcuts gets the same result for
  // the person receiving it: they double-click one thing, and afterwards JobFinder is on
  // the Start Menu and the desktop like any other app. It installs per-user, so Windows
  // never asks for an administrator — one fewer scary prompt on software that is already
  // going to trip SmartScreen.
  //
  // CRLF matters: a .bat with Unix line endings fails on older cmd.exe in ways that are
  // hard to read, and this file is the first thing that runs on their machine.
  const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(outDir, 'Install JobFinder.bat'), crlf(WIN_INSTALLER), 'utf8');
  fs.writeFileSync(path.join(outDir, 'Uninstall JobFinder.bat'), crlf(WIN_UNINSTALLER), 'utf8');
  fs.writeFileSync(path.join(outDir, 'shortcuts.ps1'), crlf(WIN_SHORTCUTS), 'utf8');
  fs.copyFileSync(path.join(HERE, 'windows/register-24x7.ps1'), path.join(outDir, 'register-24x7.ps1'));
  fs.copyFileSync(path.join(HERE, 'windows/unregister-24x7.ps1'), path.join(outDir, 'unregister-24x7.ps1'));
  fs.writeFileSync(path.join(outDir, 'START HERE.txt'), crlf(WIN_README));

  step('Zipping the Windows package');
  const zip = path.join(OUT, `${APP_NAME}-Windows.zip`);
  rm(zip);
  execSync(`cd "${outDir}" && zip -qry "${zip}" .`);
  const size = execSync(`du -sh "${zip}" | cut -f1`).toString().trim();
  ok(`${path.basename(zip)} (${size})`);
  return zip;
}

const WIN_README = `JobFinder
=========

INSTALLING

  1. Unzip this folder somewhere — Downloads is fine, it does not have to stay there.
  2. Double-click "Install JobFinder.bat".
  3. Windows may show a blue "Windows protected your PC" box, because this app is not
     code-signed. Click "More info" then "Run anyway". It happens once.

That copies JobFinder into your user folder, puts it on the Start Menu and the desktop,
enables the 24/7 Windows guard, and opens it. The app also keeps the computer awake while
it is working; the display can still turn off normally. No administrator password is
needed, and you can delete the unzipped folder afterwards.

Prefer not to install? Open the JobFinder folder and run JobFinder.exe directly. It
works exactly the same.

FIRST RUN

The first launch sets up a local AI assistant: it installs Ollama and downloads a 4.7 GB
model. That takes a while and happens once — the window tells you what it is doing the
whole time. Windows will ask you to approve the Ollama installer.

Everything after that is instant.

WHAT IT DOES WITH YOUR DATA

Nothing leaves your machine, except to the job sites you are applying to. Your CV, your
answers and your logins are stored under:

    %APPDATA%\\JobFinder\\data

Uninstalling does not touch that folder, so reinstalling keeps everything.

REMOVING IT

Double-click "Uninstall JobFinder.bat", or delete the folder from
%LOCALAPPDATA%\\Programs\\JobFinder.
`;

const WIN_INSTALLER = `@echo off
setlocal
title Install JobFinder

set "SRC=%~dp0JobFinder"
set "DEST=%LOCALAPPDATA%\\Programs\\JobFinder"

echo.
echo   Installing JobFinder
echo   ====================
echo.

if not exist "%SRC%\\JobFinder.exe" (
  echo   ERROR: JobFinder.exe was not found next to this script.
  echo   Unzip the whole download first, then run this from the unzipped folder.
  echo.
  pause
  exit /b 1
)

rem Close a running copy, otherwise the files are locked and the copy half-fails.
taskkill /IM JobFinder.exe /F >nul 2>&1

echo   Copying files to:
echo     %DEST%
echo   (about 700 MB, this takes a minute)
echo.
if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1
robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul
rem robocopy exit codes below 8 are success. Anything else is a real failure.
if errorlevel 8 (
  echo   ERROR: copying failed. Is there enough disk space?
  echo.
  pause
  exit /b 1
)

echo   Creating shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0shortcuts.ps1" >nul 2>&1

echo   Enabling 24/7 guard...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-24x7.ps1" >nul 2>&1
if errorlevel 1 (
  echo   WARNING: The 24/7 guard could not be registered.
  echo   JobFinder will still run, but Windows will not relaunch it after a full app crash.
)

echo.
echo   Done. JobFinder is on your desktop and in the Start Menu.
echo.
echo   The first launch installs a local AI model (4.7 GB, once) and will
echo   ask you to approve the Ollama installer. Leave it running.
echo.
start "" "%DEST%\\JobFinder.exe"
timeout /t 4 >nul
endlocal
`;

// Shortcut creation lives in its own file rather than inline in the .bat.
//
// Inline it needs quotes nested three deep — cmd's, PowerShell's, and the string's —
// and the first attempt lost a level of escaping to the template literal, which would
// have produced a script that fails on the recipient's machine and nowhere else. A
// separate file has no quoting problem to get wrong.
const WIN_SHORTCUTS = `$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'Programs\\JobFinder\\JobFinder.exe'
$workdir = Join-Path $env:LOCALAPPDATA 'Programs\\JobFinder'

if (-not (Test-Path $target)) {
  Write-Host "JobFinder.exe not found at $target"
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$places = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'JobFinder.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\JobFinder.lnk')
)

foreach ($p in $places) {
  $s = $shell.CreateShortcut($p)
  $s.TargetPath = $target
  $s.WorkingDirectory = $workdir
  $s.Description = 'JobFinder - find and apply to jobs'
  $s.Save()
}

Write-Host 'Shortcuts created.'
`;

const WIN_UNINSTALLER = `@echo off
setlocal
title Uninstall JobFinder

set "DEST=%LOCALAPPDATA%\\Programs\\JobFinder"

echo.
echo   This removes the JobFinder application.
echo.
echo   Your data - CV, answers, logins, saved jobs - stays in
echo     %APPDATA%\\JobFinder
echo   so reinstalling picks up where you left off.
echo.
choice /C YN /M "   Remove JobFinder"
if errorlevel 2 goto :cancelled

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0unregister-24x7.ps1" >nul 2>&1
taskkill /IM JobFinder.exe /F >nul 2>&1
timeout /t 2 >nul
if exist "%DEST%" rmdir /S /Q "%DEST%"
del "%USERPROFILE%\\Desktop\\JobFinder.lnk" >nul 2>&1
del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\JobFinder.lnk" >nul 2>&1

echo.
echo   Removed. To delete your data as well, delete this folder:
echo     %APPDATA%\\JobFinder
echo.
pause
exit /b 0

:cancelled
echo.
echo   Nothing was changed.
echo.
pause
`;

// ── Go ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nBuilding ${APP_NAME} desktop for: ${TARGETS.join(', ')}\n`);
  mkdir(STAGE);

  buildServer();
  stageApp();
  stageElectronMain();

  const built = [];
  if (TARGETS.includes('mac')) built.push(await buildMac());
  if (TARGETS.includes('win')) built.push(await buildWin());

  console.log('\nDone:\n');
  for (const b of built) console.log(`  ${b}`);
  console.log('\nRun `node desktop/verify.js` to check the packages before handing them out.\n');
})().catch((e) => {
  console.error('\nBuild failed:', e.message);
  process.exit(1);
});
