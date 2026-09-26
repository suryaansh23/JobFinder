#!/usr/bin/env node
/* eslint-disable no-console */
// Build a Windows-ready distribution of JobFinder.
//
// What this produces under `windows/dist/JobFinder/`:
//   app/                     Next.js standalone build (server.js + .next/ + node_modules subset)
//   app/public/              static assets
//   app/.next/static/        static chunks
//   node/node.exe            Windows x64 Node.js runtime
//   scripts/                 launcher .bat + PowerShell helpers
//   README.txt               shipped docs
//
// After this script finishes, hand `dist/windows/` to Inno Setup with the .iss file
// in installer/jobfinder.iss to produce the final JobFinder-Setup-<ver>.exe.
//
// Runs on macOS / Linux (cross-platform build). Doesn't require a Windows machine.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');      // the JobFinder project
const HERE = __dirname;                           // windows/ - everything Windows-specific
const OUT  = path.join(HERE, 'dist');             // build output, gitignored
const DIST = path.join(OUT, 'JobFinder');         // what the ZIP contains
const APP = path.join(DIST, 'app');
const NODE_DIR = path.join(DIST, 'node');
const NODE_VERSION = process.env.JOBFINDER_NODE_VERSION || 'v20.18.0'; // LTS, ABI 115
const NODE_ABI = '115';

// --- helpers ---------------------------------------------------------------

function step(label) { console.log(`\n▶ ${label}`); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function cprf(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dst, { recursive: true, force: true, errorOnExist: false });
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    mkdirp(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    function get(u, redirects = 0) {
      https.get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          if (redirects > 5) return reject(new Error(`Too many redirects: ${u}`));
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0; let lastPct = -1;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            if (pct !== lastPct && pct % 10 === 0) {
              lastPct = pct;
              process.stdout.write(`  ${pct}% (${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)\r`);
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    }
    get(url);
  });
}

function sizeMb(p) {
  let total = 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) walk(fp);
      else try { total += fs.statSync(fp).size; } catch { /* ignore */ }
    }
  };
  walk(p);
  return (total / 1e6).toFixed(1);
}

// --- main ------------------------------------------------------------------

async function main() {
  // 1. clean
  step('Cleaning previous build');
  rmrf(DIST);
  mkdirp(DIST);

  // 2. run next build (with data/ temporarily moved aside)
  //
  // CRITICAL: Next's file tracer otherwise drags `data/` (live SQLite DB plus the
  // logged-in Chrome sessions — cookies, cache, history, ~12 GB) into the standalone
  // output. We move it aside for the duration of the build, then restore it.
  step('Running next build (standalone)');
  const dataDir = path.join(ROOT, 'data');
  const dataBackup = path.join(ROOT, '.data-build-backup');
  let dataMoved = false;
  if (fs.existsSync(dataDir)) {
    rmrf(dataBackup);
    fs.renameSync(dataDir, dataBackup);
    dataMoved = true;
    console.log('  Moved data/ aside so Next tracer doesn\'t suck it into the build');
  }
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', JOBFINDER_STANDALONE: '1' } });
  } finally {
    if (dataMoved) {
      rmrf(dataDir);
      fs.renameSync(dataBackup, dataDir);
      console.log('  Restored data/');
    }
  }

  // 3. lay out the standalone app
  step('Assembling app/ from .next/standalone');
  mkdirp(APP);
  const standaloneDir = path.join(ROOT, '.next', 'standalone');
  if (!fs.existsSync(standaloneDir)) {
    throw new Error(`Expected ${standaloneDir} to exist. Did next build succeed?`);
  }
  cprf(standaloneDir, APP);
  // Next standalone doesn't auto-copy public/ or .next/static/ — we do it.
  cprf(path.join(ROOT, 'public'), path.join(APP, 'public'));
  cprf(path.join(ROOT, '.next', 'static'), path.join(APP, '.next', 'static'));
  // Connectors are imported dynamically — copy them verbatim.
  cprf(path.join(ROOT, 'connectors'), path.join(APP, 'connectors'));

  // Packages loaded with `await import(...)` INSIDE a function are invisible to Next's
  // static tracer, so they never reach the standalone bundle. imapflow is loaded that
  // way (deliberately — it should not be pulled in unless a mailbox is connected), and
  // the omission only surfaces on Windows the first time someone clicks Connect.
  //
  // Anything added here must also be added if a new runtime-only import appears; the
  // verify step below fails the build if one is missing rather than shipping a package
  // that crashes on first use.
  step('Copying runtime-only dependencies the tracer cannot see');
  const RUNTIME_ONLY = ['imapflow'];
  for (const mod of RUNTIME_ONLY) {
    const from = path.join(ROOT, 'node_modules', mod);
    const to = path.join(APP, 'node_modules', mod);
    if (!fs.existsSync(from)) throw new Error(`${mod} is not installed — run npm install first.`);
    if (!fs.existsSync(to)) cprf(from, to);
    // ...and its own dependency tree, which the tracer also never walked.
    const pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      const depFrom = path.join(ROOT, 'node_modules', dep);
      const depTo = path.join(APP, 'node_modules', dep);
      if (fs.existsSync(depFrom) && !fs.existsSync(depTo)) cprf(depFrom, depTo);
    }
    console.log(`  ✓ ${mod} + ${Object.keys(pkg.dependencies || {}).length} dependency tree`);
  }

  // 4. swap better-sqlite3 native binary darwin → win32-x64
  //
  // On macOS the installed better-sqlite3 has ONLY the darwin binary. Shipping that
  // to Windows would crash on first require. We download the matching win32-x64
  // prebuild (Node 20 = ABI 115) from the better-sqlite3 GitHub releases and replace
  // build/Release/better_sqlite3.node so the bindings loader finds the right one.
  step('Installing Windows-x64 better-sqlite3 binary');
  const bsqlitePkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')
  );
  const bsqliteUrl =
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsqlitePkg.version}` +
    `/better-sqlite3-v${bsqlitePkg.version}-node-v${NODE_ABI}-win32-x64.tar.gz`;
  const bsqliteTgz = path.join(DIST, 'bsqlite-win32-x64.tar.gz');
  const bsqliteAppDir = path.join(APP, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(bsqliteAppDir)) {
    throw new Error(`Expected better-sqlite3 to be present in standalone at ${bsqliteAppDir}`);
  }
  // Wipe the macOS binary first — the tarball would overwrite it but we want to be
  // sure we're not accidentally shipping a darwin .node that confuses the loader.
  const bsqliteRelease = path.join(bsqliteAppDir, 'build', 'Release');
  mkdirp(bsqliteRelease);
  for (const f of fs.readdirSync(bsqliteRelease)) fs.unlinkSync(path.join(bsqliteRelease, f));

  await download(bsqliteUrl, bsqliteTgz);
  console.log(`  ✓ Downloaded better-sqlite3 v${bsqlitePkg.version} for win32-x64 (Node ABI ${NODE_ABI})`);
  execSync(`tar -xzf "${bsqliteTgz}" -C "${bsqliteAppDir}"`, { stdio: 'inherit' });
  fs.unlinkSync(bsqliteTgz);
  const winBin = path.join(bsqliteRelease, 'better_sqlite3.node');
  if (!fs.existsSync(winBin)) {
    throw new Error(`better-sqlite3 native binary missing after extract: ${winBin}`);
  }
  console.log(`  ✓ build/Release/better_sqlite3.node installed (${(fs.statSync(winBin).size / 1024).toFixed(0)} KB)`);

  // 5. download Windows Node.js binary
  step(`Downloading Node.js ${NODE_VERSION} for Windows x64`);
  const nodeZipName = `node-${NODE_VERSION}-win-x64.zip`;
  const nodeZip = path.join(DIST, nodeZipName);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/${nodeZipName}`, nodeZip);
  console.log(`  ✓ Downloaded ${nodeZipName}`);

  step('Extracting Node.js');
  mkdirp(NODE_DIR);
  try {
    execSync(`unzip -q -o "${nodeZip}" -d "${DIST}"`, { stdio: 'inherit' });
  } catch (e) {
    throw new Error('unzip not installed. brew install unzip (or extract manually).');
  }
  const extracted = path.join(DIST, `node-${NODE_VERSION}-win-x64`);
  fs.renameSync(path.join(extracted, 'node.exe'), path.join(NODE_DIR, 'node.exe'));
  rmrf(extracted);
  fs.unlinkSync(nodeZip);
  console.log('  ✓ node.exe in dist/windows/node/');

  // 6. installer assets
  step('Copying installer assets');
  mkdirp(path.join(DIST, 'scripts'));
  cprf(path.join(HERE, 'installer', 'launcher.bat'), path.join(DIST, 'scripts', 'launcher.bat'));
  cprf(path.join(HERE, 'installer', 'server-only.bat'), path.join(DIST, 'scripts', 'server-only.bat'));
  cprf(path.join(HERE, 'installer', 'post-install-models.ps1'), path.join(DIST, 'scripts', 'post-install-models.ps1'));
  cprf(path.join(HERE, 'JobFinder-Watchdog.ps1'), path.join(DIST, 'scripts', 'JobFinder-Watchdog.ps1'));
  cprf(path.join(HERE, 'install-24x7.ps1'), path.join(DIST, 'scripts', 'install-24x7.ps1'));
  cprf(path.join(HERE, 'uninstall-24x7.ps1'), path.join(DIST, 'scripts', 'uninstall-24x7.ps1'));
  cprf(path.join(HERE, 'configure-power-24x7.ps1'), path.join(DIST, 'scripts', 'configure-power-24x7.ps1'));
  cprf(path.join(HERE, 'installer', 'README.txt'), path.join(DIST, 'README.txt'));
  fs.writeFileSync(
    path.join(DIST, 'BUILD.txt'),
    `commit=${process.env.GITHUB_SHA || 'local'}\nbuilt_at=${new Date().toISOString()}\nnode_runtime=${NODE_VERSION}\n`
  );

  // 7. summary
  // ── Verify before declaring success ───────────────────────────────────────
  //
  // Every check here exists because the corresponding thing was actually missing or
  // wrong at some point. A packaging bug that ships is only discovered by the person
  // installing it, on a machine you cannot debug.
  // ── Keep user data out of the install directory ───────────────────────────
  //
  // Next's generated server.js calls process.chdir(__dirname) on startup, which
  // silently overrides whatever working directory the launcher set. The app resolves
  // data/ from process.cwd(), so the database, resumes and browser sessions all landed
  // inside the install folder — measured, not assumed: after a request the .db appeared
  // under app/data/ rather than the directory the launcher chose.
  //
  // That is wrong twice over: an uninstall would take the user's data with it, and a
  // Program Files install would not be writable by a standard user at all.
  //
  // Patched here on the GENERATED file, so nothing in the app source changes. Next
  // captures `dir` from __dirname before this point and passes it to startServer
  // explicitly, so its own resolution is unaffected.
  step('Pointing user data at JOBFINDER_DATA rather than the install folder');
  {
    const serverJs = path.join(APP, 'server.js');
    let src = fs.readFileSync(serverJs, 'utf8');
    const anchor = 'process.chdir(__dirname)';
    if (!src.includes(anchor)) {
      throw new Error('server.js no longer contains process.chdir(__dirname) — re-check this patch against the Next version.');
    }
    if (!src.includes('JOBFINDER_DATA')) {
      src = src.replace(
        anchor,
        `${anchor}
` +
        `// [JobFinder] Data lives outside the install directory. Next has already
` +
        `// captured \`dir\` from __dirname above, so moving cwd here is safe.
` +
        `if (process.env.JOBFINDER_DATA) {
` +
        `  try { process.chdir(process.env.JOBFINDER_DATA) } catch (e) { console.error('[JobFinder] could not use JOBFINDER_DATA:', e.message) }
` +
        `}`
      );
      fs.writeFileSync(serverJs, src);
      console.log('  ✓ server.js honours JOBFINDER_DATA');
    } else {
      console.log('  ✓ already patched');
    }
  }

  // ── Repair the trace ──────────────────────────────────────────────────────
  //
  // Next 14's standalone output omits node_modules/next/package.json. Node cannot
  // resolve a directory as a module without one, so server.js dies on its very first
  // line with "Cannot find module 'next'". The original .next/standalone fails the
  // same way, so this is a defect in the trace rather than in the copy — but it means
  // the packaged app would never have started, and nothing short of running it would
  // have shown that.
  //
  // Any traced module missing its manifest gets it restored from the real tree.
  step('Repairing module manifests the tracer dropped');
  {
    const appNm = path.join(APP, 'node_modules');
    const rootNm = path.join(ROOT, 'node_modules');
    let repaired = 0;
    const scan = (dir, prefix = '') => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const name = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.name.startsWith('@')) { scan(path.join(dir, e.name), e.name); continue; }
        const target = path.join(appNm, name, 'package.json');
        if (fs.existsSync(target)) continue;
        const source = path.join(rootNm, name, 'package.json');
        if (!fs.existsSync(source)) continue;
        fs.copyFileSync(source, target);
        console.log(`  ✓ restored ${name}/package.json`);
        repaired++;
      }
    };
    scan(appNm);
    if (!repaired) console.log('  ✓ nothing to repair');
  }

  // The one-click installer sits at the ROOT of the bundle so the ZIP extracts to a
  // folder where double-clicking it is the obvious next action.
  cprf(path.join(HERE, 'installer', 'Install-JobFinder.bat'), path.join(DIST, 'Install-JobFinder.bat'));

  step('Verifying the bundle');
  const problems = [];

  // Native binary must be a Windows PE, not the darwin one from this machine.
  const sqlitePath = path.join(APP, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(sqlitePath)) problems.push('better_sqlite3.node missing');
  else {
    const head = fs.readFileSync(sqlitePath).subarray(0, 2).toString('latin1');
    if (head !== 'MZ') problems.push(`better_sqlite3.node is not a Windows binary (magic "${head}")`);
  }
  const nodeExe = path.join(NODE_DIR, 'node.exe');
  if (!fs.existsSync(nodeExe)) problems.push('node.exe missing');
  else if (fs.readFileSync(nodeExe).subarray(0, 2).toString('latin1') !== 'MZ') problems.push('node.exe is not a Windows binary');

  // Files read from disk at runtime rather than imported — the tracer cannot see these.
  for (const rel of ['lib/toolbar.src.js', 'server.js', 'connectors/index.js']) {
    if (!fs.existsSync(path.join(APP, rel))) problems.push(`${rel} missing from app/`);
  }

  // Modules the app needs at runtime.
  for (const mod of ['better-sqlite3', 'imapflow', 'rebrowser-playwright', 'pg']) {
    if (!fs.existsSync(path.join(APP, 'node_modules', mod))) problems.push(`node_modules/${mod} missing`);
  }
  // rebrowser-playwright resolves its engine through a NESTED playwright-core.
  if (!fs.existsSync(path.join(APP, 'node_modules', 'rebrowser-playwright', 'node_modules', 'playwright-core'))) {
    problems.push('rebrowser-playwright/node_modules/playwright-core missing (browser automation would fail)');
  }

  // Nothing personal may ever be packaged.
  for (const leak of ['data', '.env', '.env.local']) {
    if (fs.existsSync(path.join(APP, leak))) problems.push(`${leak}/ leaked into the bundle`);
  }

  if (problems.length) {
    console.error('\n  ✗ Bundle verification FAILED:');
    for (const p2 of problems) console.error(`     - ${p2}`);
    throw new Error(`${problems.length} problem(s) — refusing to declare the build good.`);
  }
  console.log('  ✓ native binaries are Windows PE, runtime files and modules all present, no data/ leak');

  // Ship a ZIP: one file to move to the Windows machine, and Explorer's built-in
  // "Extract All" is enough to unpack it — no third-party tool needed.
  step('Packaging JobFinder-Windows.zip');
  const zipPath = path.join(OUT, 'JobFinder-Windows.zip');
  rmrf(zipPath);
  try {
    // Zip the JobFinder folder itself, so extracting gives a single tidy directory.
    execSync(`cd "${OUT}" && zip -q -r "${zipPath}" JobFinder -x "*.DS_Store"`, { stdio: 'inherit' });
    const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
    console.log(`  ✓ windows/dist/JobFinder-Windows.zip (${mb} MB)`);
  } catch {
    console.log('  ! zip not available — copy dist/windows/ across manually.');
  }

  step('Build complete');
  console.log(`\n  📦 windows/dist/JobFinder/  →  ${sizeMb(DIST)} MB`);
  console.log('');
  console.log('  Ready to ship: windows/dist/JobFinder-Windows.zip');
  console.log('  Move it to the Windows machine, Extract All, then double-click');
  console.log('  JobFinder\\Install-JobFinder.bat - no admin rights, no toolchain needed.');
  console.log('');
  console.log('  (Optional) For a signed .exe instead: run Inno Setup on windows/installer/jobfinder.iss');
}

main().catch((e) => {
  console.error('\n✗ Build failed:', e.message);
  process.exit(1);
});
