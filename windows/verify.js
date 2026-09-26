#!/usr/bin/env node
/* eslint-disable no-console */
// Independent check that dist/windows/ is actually shippable.
//
// Split out of build-windows.js so it can be run on its own — against a bundle built
// earlier, in CI, or after hand-editing the tree. Every assertion here exists because
// the corresponding thing was genuinely missing or wrong at some point; a packaging bug
// that ships is only ever discovered by the person installing it.
//
//   node scripts/verify-windows-build.js

const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, 'dist', 'JobFinder');
const APP = path.join(DIST, 'app');

const problems = [];
const ok = [];

function isWindowsBinary(p) {
  try { return fs.readFileSync(p).subarray(0, 2).toString('latin1') === 'MZ'; } catch { return false; }
}

if (!fs.existsSync(APP)) {
  console.error('✗ windows/dist/JobFinder/app does not exist — run: npm run build:windows');
  process.exit(1);
}

// 1. Native code must be built for Windows, not for the machine that packaged it.
const sqlite = path.join(APP, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(sqlite)) problems.push('better_sqlite3.node missing');
else if (!isWindowsBinary(sqlite)) problems.push('better_sqlite3.node is not a Windows PE — the darwin build was shipped');
else ok.push('better_sqlite3.node is a Windows PE');

// The shortcut points at this; a malformed .ico degrades to the generic .bat icon
// without any error, so check the magic rather than mere existence.
const ico = path.join(APP, 'public', 'favicon.ico');
if (fs.existsSync(ico)) {
  const h = fs.readFileSync(ico).subarray(0, 4);
  if (h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0) ok.push('favicon.ico is a valid icon');
  else problems.push('favicon.ico is not a valid ICO — the shortcut would show a generic icon');
}

const nodeExe = path.join(DIST, 'node', 'node.exe');
if (!fs.existsSync(nodeExe)) problems.push('node/node.exe missing');
else if (!isWindowsBinary(nodeExe)) problems.push('node.exe is not a Windows PE');
else ok.push('node.exe is a Windows PE');

// 2. Files the app reads from disk at runtime. Next traces imports, not fs reads, so
//    these are invisible to it and vanish silently.
for (const rel of ['lib/toolbar.src.js', 'server.js', 'connectors/index.js', '.next/static', 'public', 'public/favicon.ico']) {
  if (fs.existsSync(path.join(APP, rel))) ok.push(`${rel} present`);
  else problems.push(`${rel} missing from app/`);
}

// 3. Modules needed at runtime, including ones imported dynamically.
for (const mod of ['better-sqlite3', 'imapflow', 'rebrowser-playwright', 'playwright-core', 'pg', 'next', 'react']) {
  if (fs.existsSync(path.join(APP, 'node_modules', mod))) ok.push(`node_modules/${mod}`);
  else problems.push(`node_modules/${mod} missing`);
}
// rebrowser-playwright reaches its engine through a NESTED playwright-core alias.
const nested = path.join(APP, 'node_modules', 'rebrowser-playwright', 'node_modules', 'playwright-core');
if (fs.existsSync(nested)) ok.push('rebrowser-playwright nested engine');
else problems.push('rebrowser-playwright/node_modules/playwright-core missing — all browser automation would fail');

// 3b. Every bundled module needs its package.json — Node cannot resolve a directory
//     as a module without one, and Next's tracer drops next/package.json.
{
  const nm = path.join(APP, 'node_modules');
  const missing = [];
  const scan = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.name.startsWith('@')) { scan(path.join(dir, e.name), e.name); continue; }
      if (!fs.existsSync(path.join(dir, e.name, 'package.json'))) missing.push(name);
    }
  };
  scan(nm);
  if (missing.length) problems.push(`module(s) missing package.json (unresolvable): ${missing.join(', ')}`);
  else ok.push('every bundled module has a package.json');
}

// 4. Nothing personal may ever be packaged.
for (const leak of ['data', '.env', '.env.local', '.git']) {
  if (fs.existsSync(path.join(APP, leak))) problems.push(`${leak} leaked into the bundle`);
}
ok.push('no data/, .env or .git in the bundle');

// 5. Installer assets the .iss references.
for (const rel of [
  'scripts/launcher.bat',
  'scripts/server-only.bat',
  'scripts/post-install-models.ps1',
  'scripts/google-sheets-setup.js',
  'scripts/configure-google-sheets.bat',
  'scripts/JobFinder.env.cmd.example',
  'scripts/24x7-control.js',
  'scripts/24x7-control.bat',
  'scripts/JobFinder-Watchdog.ps1',
  'scripts/install-24x7.ps1',
  'scripts/uninstall-24x7.ps1',
  'scripts/configure-power-24x7.ps1',
  'Install-JobFinder.bat',
  'BUILD.txt',
]) {
  if (fs.existsSync(path.join(DIST, rel))) ok.push(rel);
  else problems.push(`${rel} missing from the bundle root`);
}

const mb = (() => {
  let total = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else try { total += fs.statSync(p).size; } catch { /* ignore */ }
    }
  })(DIST);
  return (total / 1048576).toFixed(1);
})();

console.log(`\nBundle: windows/dist/JobFinder/  (${mb} MB)\n`);
console.log(`  ✓ ${ok.length} check(s) passed`);
if (problems.length) {
  console.error(`\n  ✗ ${problems.length} problem(s):`);
  for (const p of problems) console.error(`     - ${p}`);
  process.exit(1);
}
console.log('  ✓ bundle looks shippable\n');
