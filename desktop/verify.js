#!/usr/bin/env node
/* eslint-disable no-console */
// Check the built packages before handing them to anyone.
//
// The macOS build can be launched here and proved. The Windows one cannot — this is a
// Mac — so every Windows failure mode has to be caught structurally instead, and the
// ones that matter are silent: a native module compiled for the wrong platform starts
// fine and throws on the first database call, which on someone else's machine looks
// like a blank window and nothing else.
//
// So the binaries are checked by reading their file headers, not by trusting the build.
//
//   node desktop/verify.js

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const OUT = path.join(__dirname, 'dist');
let failed = 0;
let checks = 0;

const ok = (m, d = '') => { checks++; console.log(`  ok    ${m}${d ? `  ${d}` : ''}`); };
const bad = (m, d = '') => { checks++; failed++; console.log(`  FAIL  ${m}${d ? `\n        ${d}` : ''}`); };
const skip = (m) => console.log(`  --    ${m}`);

function exists(p, label) {
  if (fs.existsSync(p)) { ok(label); return true; }
  bad(label, `missing: ${p}`);
  return false;
}

/** First bytes of a binary tell you what it will run on. Trust those, not the build. */
function magic(file) {
  if (!fs.existsSync(file)) return 'missing';
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';                 // MZ — Windows
  if (buf.readUInt32BE(0) === 0xcffaedfe || buf.readUInt32LE(0) === 0xfeedfacf) return 'macho';
  if (buf.readUInt32BE(0) === 0xcafebabe) return 'macho-fat';
  if (buf[0] === 0x7f && buf.toString('latin1', 1, 4) === 'ELF') return 'elf';
  return 'unknown';
}

function arch(file) {
  try { return execSync(`file -b "${file}"`).toString().trim().slice(0, 60); }
  catch { return '?'; }
}

/** Nothing in a shipped package should explain how the product works. */
function scanForSource(root, label) {
  // Prose only.
  //
  // Deliberately NOT identifiers or endpoint paths: "pseudojobs" is Naukri's own URL and
  // has to survive for the code to work, and renaming internal functions to hide them
  // buys nothing while risking a runtime break. What must not ship is the reasoning —
  // the sentences that explain WHY the code does what it does, which is the part that
  // would actually teach someone the product.
  const needles = [
    'THE RULE THAT DECIDES', 'purchasing power, not the exchange',
    'WHY A BOOKMARKLET', 'Naukri calls them', 'FOUR BRAKES',
    'A dropdown sitting on', 'honeypot is a self-inflicted',
    'the second copy was cut short', 'is a self-inflicted bot verdict',
    'THE PROBLEM', 'ON STEALTH', 'what makes it survive navigation',
  ];
  let hits = [];
  try {
    const pattern = needles.map((n) => n.replace(/'/g, "'\\''")).join('\\|');
    const out = execSync(`grep -rl '${pattern}' "${root}" 2>/dev/null || true`).toString().trim();
    hits = out ? out.split('\n').filter(Boolean) : [];
  } catch { /* grep found nothing */ }
  if (hits.length) bad(`${label}: no explanatory source in the package`, hits.slice(0, 3).join('\n        '));
  else ok(`${label}: no explanatory source in the package`);

  let maps = 0;
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js.map')) maps++;
    }
  })(root);
  if (maps) bad(`${label}: no source maps`, `${maps} found — these undo the compilation`);
  else ok(`${label}: no source maps`);
}

function verifyMac() {
  const app = path.join(OUT, 'mac/JobFinder.app');
  console.log('\nmacOS package');
  if (!fs.existsSync(app)) { skip('not built (run: node desktop/build.js mac)'); return; }
  const C = path.join(app, 'Contents');
  const R = path.join(C, 'Resources');

  exists(path.join(C, 'MacOS/JobFinder'), 'launcher is named JobFinder');
  exists(path.join(R, 'app.asar'), 'desktop shell sealed in app.asar');
  exists(path.join(R, 'app/server.js'), 'application server present');
  exists(path.join(R, 'app/.next/static'), 'static assets present (UI would be unstyled without them)');

  const plist = fs.readFileSync(path.join(C, 'Info.plist'), 'utf8');
  if (/<string>JobFinder<\/string>/.test(plist)) ok('Info.plist is branded JobFinder');
  else bad('Info.plist is branded JobFinder', 'still says Electron — the Dock and Force Quit would show that');

  const node = path.join(R, 'runtime/node');
  if (magic(node) === 'macho') ok('bundled Node is a macOS binary', arch(node));
  else bad('bundled Node is a macOS binary', `header says ${magic(node)}`);

  try {
    const v = execSync(`"${node}" -v`).toString().trim();
    ok('bundled Node runs', v);
  } catch (e) { bad('bundled Node runs', e.message.split('\n')[0]); }

  const sq = path.join(R, 'app/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (magic(sq).startsWith('macho')) ok('database module is a macOS binary', arch(sq));
  else bad('database module is a macOS binary', `header says ${magic(sq)} — every database call would throw`);

  const chrome = path.join(R, 'chromium/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
  if (fs.existsSync(chrome)) {
    try { ok('bundled Chromium runs', execSync(`"${chrome}" --version`).toString().trim()); }
    catch { bad('bundled Chromium runs', 'present but would not start'); }
  } else bad('bundled Chromium present', `missing: ${chrome}`);

  scanForSource(R, 'macOS');
}

function verifyWin() {
  const dir = path.join(OUT, 'win/JobFinder');
  console.log('\nWindows package');
  if (!fs.existsSync(dir)) { skip('not built (run: node desktop/build.js win)'); return; }
  const R = path.join(dir, 'resources');

  exists(path.join(dir, 'JobFinder.exe'), 'launcher is named JobFinder.exe');
  exists(path.join(R, 'app.asar'), 'desktop shell sealed in app.asar');
  exists(path.join(R, 'app/server.js'), 'application server present');
  exists(path.join(R, 'app/.next/static'), 'static assets present');
  exists(path.join(OUT, 'win/START HERE.txt'), 'instructions included');
  // The zip must contain the installer at its ROOT, not buried — the first thing the
  // recipient sees after unzipping has to be the thing to double-click.
  try {
    const listing = execSync(`unzip -l "${path.join(OUT, 'JobFinder-Windows.zip')}"`).toString();
    if (/Install JobFinder\.bat/.test(listing)) ok('installer is inside the zip');
    else bad('installer is inside the zip');
  } catch { bad('installer is inside the zip', 'could not read the zip'); }

  const exe = path.join(dir, 'JobFinder.exe');
  if (magic(exe) === 'pe') ok('launcher is a Windows executable');
  else bad('launcher is a Windows executable', `header says ${magic(exe)}`);

  const node = path.join(R, 'runtime/node.exe');
  if (magic(node) === 'pe') ok('bundled Node is a Windows binary');
  else bad('bundled Node is a Windows binary', `header says ${magic(node)} — the server would never start`);

  // The one that bites: a macOS .node shipped to Windows starts the app and then throws
  // on the first query, which looks like the app is simply broken.
  const sq = path.join(R, 'app/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (magic(sq) === 'pe') ok('database module is a Windows binary');
  else bad('database module is a Windows binary', `header says ${magic(sq)} — the app would open and then fail on first use`);

  const chrome = [
    path.join(R, 'chromium/chrome-win/chrome.exe'),
    path.join(R, 'chromium/chrome.exe'),
  ].find((p) => fs.existsSync(p));
  if (chrome && magic(chrome) === 'pe') ok('bundled Chromium is a Windows binary');
  else bad('bundled Chromium is a Windows binary', chrome ? `header says ${magic(chrome)}` : 'chrome.exe not found');

  // The install experience. None of this can be run here, so it is checked by reading
  // the files — and the things checked are the ones that fail silently on the
  // recipient's machine and nowhere else.
  const inst = path.join(OUT, 'win/Install JobFinder.bat');
  const uninst = path.join(OUT, 'win/Uninstall JobFinder.bat');
  const ps1 = path.join(OUT, 'win/shortcuts.ps1');
  const guard = path.join(OUT, 'win/register-24x7.ps1');
  const unguard = path.join(OUT, 'win/unregister-24x7.ps1');
  exists(inst, 'installer included');
  exists(uninst, 'uninstaller included');
  exists(ps1, 'shortcut script included');
  exists(guard, '24x7 guard registration included');
  exists(unguard, '24x7 guard removal included');

  for (const [f, label] of [[inst, 'installer'], [uninst, 'uninstaller'], [ps1, 'shortcut script']]) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n').length - 1;
    const crlf = (text.match(/\r\n/g) || []).length;
    // A .bat with Unix line endings fails on cmd.exe in ways that are hard to read.
    if (crlf === lines && lines > 0) ok(`${label} has Windows line endings`);
    else bad(`${label} has Windows line endings`, `${crlf} of ${lines} lines`);
  }

  if (fs.existsSync(inst)) {
    const text = fs.readFileSync(inst, 'utf8');
    // robocopy returns 1 for "files copied" — treating that as failure would make a
    // successful install report an error.
    if (/errorlevel 8/.test(text)) ok('installer reads robocopy exit codes correctly');
    else bad('installer reads robocopy exit codes correctly', 'any non-zero code would be treated as failure');
    if (/taskkill \/IM JobFinder\.exe/.test(text)) ok('installer closes a running copy before copying');
    else bad('installer closes a running copy before copying', 'locked files would half-copy');
    if (!/powershell[^\n]*\$s\.TargetPath/.test(text)) ok('no inline PowerShell quoting in the .bat');
    else bad('no inline PowerShell quoting in the .bat', 'nested quotes here are what broke the first attempt');
    if (/register-24x7\.ps1/i.test(text)) ok('installer enables the 24x7 guard');
    else bad('installer enables the 24x7 guard');
  }

  if (fs.existsSync(ps1)) {
    const text = fs.readFileSync(ps1, 'utf8');
    if (/Test-Path \$target/.test(text)) ok('shortcut script checks the target exists first');
    else bad('shortcut script checks the target exists first', 'it would make a shortcut to nothing');
  }
  if (fs.existsSync(guard)) {
    const text = fs.readFileSync(guard, 'utf8');
    if (/New-ScheduledTaskTrigger -AtLogOn/.test(text)) ok('24x7 guard starts at logon');
    else bad('24x7 guard starts at logon');
    if (/RepetitionInterval .*Minutes 1/.test(text)) ok('24x7 guard checks for a dead app every minute');
    else bad('24x7 guard checks for a dead app every minute');
    if (/MultipleInstances IgnoreNew/.test(text)) ok('24x7 guard will not stack duplicate app instances');
    else bad('24x7 guard will not stack duplicate app instances');
  }

  const zip = path.join(OUT, 'JobFinder-Windows.zip');
  if (fs.existsSync(zip)) {
    const mb = Math.round(fs.statSync(zip).size / 1e6);
    ok('distributable zip built', `${mb} MB`);
  } else bad('distributable zip built');

  scanForSource(R, 'Windows');
}

verifyMac();
verifyWin();

console.log(`\n${failed ? `❌ ${failed} of ${checks} checks failed` : `✅ all ${checks} checks passed`}\n`);
process.exit(failed ? 1 : 0);
