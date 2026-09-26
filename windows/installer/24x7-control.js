#!/usr/bin/env node
/* eslint-disable no-console */
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline/promises');

const BASE = 'http://127.0.0.1:3737';

async function api(pathname, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

function openDashboard() {
  try {
    const c = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', BASE], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    c.unref();
  } catch {}
}

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      const h = await api('/api/health', { timeoutMs: 2500 });
      if (h.ok) return h;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('JobFinder server is not responding on http://127.0.0.1:3737');
}

async function profiles() {
  const r = await api('/api/profiles');
  return r.profiles || [];
}

async function chooseProfile(rl, list) {
  if (!list.length) throw new Error('No JobFinder profile exists. Open the dashboard and create your profile first.');
  if (list.length === 1) return list[0];

  console.log('');
  console.log('Profiles:');
  list.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} ${p.email ? '<' + p.email + '>' : ''}`));
  const raw = await rl.question('Choose profile number: ');
  const idx = Number(raw) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) throw new Error('Invalid profile choice.');
  return list[idx];
}

async function readiness(profile) {
  const [orchestrator, cv] = await Promise.all([
    api(`/api/orchestrator?profile_id=${encodeURIComponent(profile.id)}`),
    api(`/api/cv?profile_id=${encodeURIComponent(profile.id)}`),
  ]);

  let sheetLive = false;
  let sheetError = '';
  if (orchestrator?.tracker?.configured) {
    try {
      await api('/api/interventions', {
        method: 'POST',
        body: { profile_id: profile.id },
        timeoutMs: 30000,
      });
      sheetLive = true;
    } catch (e) {
      sheetError = e.message;
    }
  }

  const variants = cv.variants || [];
  const hasCv = variants.length > 0 || !!String(profile.resume_path || '').trim();
  const keywords = String(profile.keywords || '').trim();
  const locations = String(profile.locations || '').trim();

  return {
    orchestrator,
    variants,
    hasCv,
    keywords,
    locations,
    sheetConfigured: !!orchestrator?.tracker?.configured,
    sheetLive,
    sheetError,
  };
}

function printReadiness(profile, r) {
  console.log('');
  console.log('-----------------------------------------------------------');
  console.log(` Profile:       ${profile.name}`);
  console.log(` Google Sheet:  ${r.sheetLive ? 'CONNECTED' : (r.sheetConfigured ? 'CONFIGURED BUT ERROR' : 'NOT CONFIGURED')}`);
  console.log(` CV:            ${r.hasCv ? 'READY' : 'MISSING'}`);
  console.log(` Keywords:      ${r.keywords || '(empty)'}`);
  console.log(` Locations:     ${r.locations || '(empty)'}`);
  const s = r.orchestrator?.recentRuns?.[0];
  if (s) console.log(` Last run:      ${s.state || 'unknown'}`);
  console.log('-----------------------------------------------------------');
  if (r.sheetError) console.log(' Google error: ' + r.sheetError);
}

async function scheduleStatus(profileId) {
  return api(`/api/orchestrator-schedule?profile_id=${encodeURIComponent(profileId)}`);
}

async function setSchedule(profileId, armed) {
  return api('/api/orchestrator-schedule', {
    method: 'PUT',
    body: {
      profile_id: profileId,
      enabled: true,
      armed,
      everyMinutes: 60,
      limit: 10,
      dailyCap: 30,
      scan: true,
      scanEveryMinutes: 60,
    },
  });
}

async function pause(profileId) {
  return api('/api/orchestrator-schedule', {
    method: 'PUT',
    body: {
      profile_id: profileId,
      enabled: false,
      armed: false,
      everyMinutes: 60,
      limit: 10,
      dailyCap: 30,
      scan: true,
      scanEveryMinutes: 60,
    },
  });
}

async function firstDryRun(profile) {
  console.log('');
  console.log('Starting the first discovery scan. This can take several minutes.');
  console.log('If LinkedIn/Naukri need sign-in, JobFinder may open a Chrome window.');
  const scan = await api('/api/scan', {
    method: 'POST',
    body: { profile_id: profile.id },
    timeoutMs: 12 * 60 * 1000,
  });
  const found = (scan.results || []).reduce((n, x) => n + Number(x.found || 0), 0);
  console.log(`Discovery scan completed: ${found} new job(s).`);

  console.log('Running a safe dry-run batch now...');
  const run = await api('/api/orchestrator', {
    method: 'POST',
    body: { profile_id: profile.id, armed: false, limit: 10 },
    timeoutMs: 15 * 60 * 1000,
  });
  console.log(`Dry run: selected ${run.selected || 0}, ready/held ${run.engine?.dryRun || 0}, action required ${run.actionRequired || 0}.`);
  return run;
}

async function main() {
  if (process.argv.includes('--self-test')) {
    if (BASE !== 'http://127.0.0.1:3737') throw new Error('Controller base URL changed unexpectedly.');
    console.log('24x7 controller self-test passed.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('===========================================================');
    console.log(' JobFinder - 24x7 Control');
    console.log('===========================================================');

    await waitForServer();
    const profile = await chooseProfile(rl, await profiles());
    const ready = await readiness(profile);
    printReadiness(profile, ready);

    console.log('');
    console.log('1. Show 24x7 schedule status');
    console.log('2. Enable SAFE 24x7 dry-run + start first cycle now');
    console.log('3. ARM LIVE 24x7 applications');
    console.log('4. Pause 24x7 orchestrator');
    console.log('5. Open dashboard');
    console.log('0. Exit');
    const choice = (await rl.question('Choose: ')).trim();

    if (choice === '1') {
      const s = await scheduleStatus(profile.id);
      console.log('');
      console.log(JSON.stringify(s, null, 2));
      return;
    }

    if (choice === '2') {
      if (!ready.sheetLive) throw new Error('Google Sheet is not connected and validated. Run configure-google-sheets.bat first.');
      if (!ready.hasCv) throw new Error('No CV is configured. Upload at least one CV in the JobFinder dashboard first.');
      if (!ready.keywords) console.log('[!] Keywords are empty. The scan may be much broader than intended.');
      if (!ready.locations) console.log('[!] Locations are empty. The scan may include locations you do not want.');

      await setSchedule(profile.id, false);
      console.log('SAFE 24x7 schedule enabled: hourly scan, up to 10 dry-run applications per cycle.');
      const now = (await rl.question('Start the first scan + dry run now? [Y/n]: ')).trim();
      if (now.toLowerCase() !== 'n') await firstDryRun(profile);
      return;
    }

    if (choice === '3') {
      if (!ready.sheetLive) throw new Error('Google Sheet is not connected and validated.');
      if (!ready.hasCv) throw new Error('No CV is configured.');
      const current = await scheduleStatus(profile.id);
      if (!current.enabled) {
        throw new Error('Enable and review SAFE dry-run mode first before arming LIVE.');
      }
      console.log('');
      console.log('LIVE mode sends real applications without someone watching the browser.');
      console.log('Daily cap: 30 confirmed applications. Per-cycle cap: 10.');
      const confirm = (await rl.question('Type LIVE to arm real submissions: ')).trim();
      if (confirm !== 'LIVE') {
        console.log('Live mode not armed.');
        return;
      }
      await setSchedule(profile.id, true);
      console.log('LIVE 24x7 orchestrator is ARMED.');
      return;
    }

    if (choice === '4') {
      await pause(profile.id);
      console.log('24x7 orchestrator paused.');
      return;
    }

    if (choice === '5') {
      openDashboard();
      console.log('Dashboard opened.');
      return;
    }

    console.log('No changes made.');
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error('');
  console.error('[X] ' + String(e?.message || e));
  console.error('');
  console.error('Open the JobFinder dashboard if you need to create a profile, upload a CV, or sign into job boards.');
  process.exit(1);
});
