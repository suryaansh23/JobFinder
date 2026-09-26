// JobFinder desktop — the Electron main process.
//
// What this is responsible for, in order:
//   1. Put a window on screen immediately, with something to read. A packaged app that
//      shows nothing for two minutes while it downloads a model is an app people force-quit.
//   2. Get the machine ready (Ollama + models). See setup.js.
//   3. Start the bundled application server on a free port, pointed at a per-user data
//      directory, using the Chromium that ships inside the package.
//   4. Swap the window over to the dashboard.
//
// The server is a child process rather than something running inside Electron: it needs
// real Node, native modules (better-sqlite3) and its own lifecycle, and keeping it
// separate means a crash there is recoverable instead of taking the window with it.

const { app, BrowserWindow, shell, dialog, Menu, powerSaveBlocker } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');

const { ensureRuntime } = require('./setup');

const isMac = process.platform === 'darwin';
const RES = process.resourcesPath || path.join(__dirname, '..');
const APP_DIR = path.join(RES, 'app');            // the packaged server
const NODE_BIN = nodeBinary();
const CHROMIUM = bundledChromium();

let win = null;
let server = null;
let serverPort = 0;
let shuttingDown = false;
let serverRestartTimer = null;
let serverRestartCount = 0;
let powerBlockerId = null;

/** The Node runtime that runs the server. Shipped beside the app so nothing is assumed. */
function nodeBinary() {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const shipped = path.join(RES, 'runtime', name);
  return fs.existsSync(shipped) ? shipped : process.execPath;
}

/** The Chromium that ships in the package, used for searching and applying. */
function bundledChromium() {
  const base = path.join(RES, 'chromium');
  if (!fs.existsSync(base)) return '';
  const candidates = process.platform === 'darwin'
    ? ['Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['chrome.exe', 'chrome-win/chrome.exe']
      : ['chrome', 'chrome-linux/chrome'];
  // Playwright's layout differs a little between revisions, so look one level down too.
  const roots = [base, ...fs.readdirSync(base).map((d) => path.join(base, d))];
  for (const r of roots) {
    for (const c of candidates) {
      const p = path.join(r, c);
      try { if (fs.existsSync(p)) return p; } catch { /* not a directory */ }
    }
  }
  return '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 500);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    attempt();
  });
}

/** Everything the user creates lives here, never inside the app bundle. */
function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function splash(message, detail = '') {
  if (!win) return;
  const html = `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:dark}
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0d1117;color:#c9d1d9;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .box{max-width:460px;text-align:center;padding:32px}
    .logo{font-size:40px;margin-bottom:14px}
    h1{font-size:19px;margin:0 0 6px;font-weight:600;color:#e6edf3}
    p{margin:10px 0 0;color:#8b949e;font-size:13.5px}
    .bar{margin-top:22px;height:3px;background:#21262d;border-radius:99px;overflow:hidden}
    .bar i{display:block;height:100%;width:35%;background:#58a6ff;border-radius:99px;
      animation:slide 1.4s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
  </style><div class="box"><div class="logo">🎯</div>
    <h1>${escapeHtml(message)}</h1>
    ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
    <div class="bar"><i></i></div>
    <p style="margin-top:20px;font-size:12px;color:#6e7681">You can leave this running — it keeps working in the background.</p>
  </div>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function dashboardUrl() {
  return `http://127.0.0.1:${serverPort}/?shell=desktop`;
}

function startServer(port) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    // Everything the user owns lives outside the app bundle, so an update or a
    // reinstall cannot take their answer bank and logins with it.
    JOBFINDER_DATA: dataDir(),
    // FALLBACK, not PATH. lib/browser.js tries a real installed Chrome first — that
    // browser has history and logins, which is precisely what anti-bot systems score —
    // and only reaches for the Chromium we ship when the machine has nothing.
    ...(CHROMIUM ? { JOBFINDER_BROWSER_FALLBACK: CHROMIUM } : {}),
  };
  const child = spawn(NODE_BIN, [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    server = null;
    serverRestartCount += 1;
    const delay = Math.min(30000, 3000 * serverRestartCount);
    splash(
      'Recovering JobFinder',
      `The background service stopped unexpectedly (code ${code}). Restarting automatically…`
    );
    if (serverRestartTimer) clearTimeout(serverRestartTimer);
    serverRestartTimer = setTimeout(async () => {
      if (shuttingDown) return;
      try {
        server = startServer(port);
        const ok = await waitForServer(port, 45000);
        if (!ok) throw new Error('server did not become healthy');
        serverRestartCount = 0;
        if (win && !win.isDestroyed()) await win.loadURL(dashboardUrl());
      } catch (e) {
        console.error('[desktop] server recovery failed:', e?.message || e);
        try { if (server) server.kill(); } catch {}
      }
    }, delay);
  });
  return child;
}

async function boot() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0d1117',
    title: 'JobFinder',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Links to real websites open in the user's own browser, not inside this window —
  // a job posting belongs in a browser with their sessions and their password manager.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  splash('Starting JobFinder', 'Getting everything ready…');
  win.show();

  const runtime = await ensureRuntime((msg) => splash('Setting up', msg));

  splash('Starting JobFinder', 'Almost there…');
  serverPort = await freePort();
  server = startServer(serverPort);

  const ok = await waitForServer(serverPort);
  if (!ok) {
    splash('JobFinder could not start', 'The application server did not come up. Please reopen the app.');
    return;
  }

  // ?shell=desktop tells the page it is inside the app window rather than a browser
  // tab, so it can reserve the strip macOS draws its window buttons over.
  serverRestartCount = 0;
  await win.loadURL(dashboardUrl());

  if (runtime.note) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Setup finished with a warning',
      message: runtime.note,
      detail: 'Scanning, applying and your answer bank all work. Drafted answers and interview prep need the local AI runtime.',
      buttons: ['Continue'],
    });
  }
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Where is my data?',
          click: () => shell.openPath(dataDir()),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One window, one instance. A second copy would fight the first over the browser
// profile and the database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    // This machine is intended to work unattended. Keep the system awake while
    // allowing the display to turn off normally.
    if (powerBlockerId == null) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    if (process.platform === 'win32') {
      try { app.setLoginItemSettings({ openAtLogin: true, path: process.execPath }); } catch {}
    }
    buildMenu();
    boot();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });
  });

  app.on('window-all-closed', () => { if (!isMac) app.quit(); });

  app.on('before-quit', () => {
    shuttingDown = true;
    if (serverRestartTimer) clearTimeout(serverRestartTimer);
    if (powerBlockerId != null && powerSaveBlocker.isStarted(powerBlockerId)) {
      try { powerSaveBlocker.stop(powerBlockerId); } catch {}
    }
    if (server) { try { server.kill(); } catch { /* already gone */ } }
  });
}
