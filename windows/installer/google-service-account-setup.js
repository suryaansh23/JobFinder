#!/usr/bin/env node
/* eslint-disable no-console */
// Configure a dedicated Google Sheets service account for the single-user JobFinder tracker.
// No OAuth consent screen, testing status, refresh token, or public website required.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SPREADSHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

function parseSheet(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

function parseKey(file) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (obj.type !== 'service_account' || !/\.gserviceaccount\.com$/.test(obj.client_email || '') ||
      !obj.private_key || obj.token_uri !== TOKEN_URL) {
    throw new Error('Please select the JSON key for a Google Cloud service account.');
  }
  crypto.createPrivateKey(obj.private_key);
  return obj;
}

function signedAssertion(key) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const message = [
    enc({ alg: 'RS256', typ: 'JWT' }),
    enc({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  ].join('.');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(message), key.private_key).toString('base64url');
  return message + '.' + sig;
}

async function verifySheetAccess(key, spreadsheetId) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedAssertion(key),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await response.json().catch(() => ({}));
  if (!response.ok || !j.access_token) {
    throw new Error('Service-account authorization failed: ' + (j.error_description || j.error || response.status));
  }

  const auth = { authorization: 'Bearer ' + j.access_token };
  const read = async (range) => {
    const r = await fetch(
      SPREADSHEETS + '/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent(range),
      { headers: auth, signal: AbortSignal.timeout(30000) }
    );
    const value = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error('Tracker access failed: ' + (value?.error?.message || r.status) +
        '. Share the sheet with ' + key.client_email + ' as Editor.');
    }
    return value.values?.[0] || [];
  };

  const expected = [
    ['Automation Queue', ['record_id','job_id','queued_at','company','role','location','source','url','priority','status','apply_channel','cv','confirmation','application_reference','applied_at','action_required','action_reason','last_attempt_at','attempts','notes']],
    ['Interventions', ['intervention_id','profile_id','field_key','job_id','company','role','question','type','options','answer','status','asked_at','resolved_at']],
  ];
  for (const [tab, columns] of expected) {
    const actual = await read("'" + tab + "'!A1:" + (columns.length === 20 ? 'T1' : 'M1'));
    if (!columns.every((column, i) => actual[i] === column)) {
      throw new Error('Tab "' + tab + '" is missing or has unexpected headers. Check the JobFinder Master Tracker.');
    }
  }

  // Confirm Editor access without altering tracker content: write the first
  // header back to the same cell. A Viewer share must not pass setup.
  const writeRange = encodeURIComponent("'Automation Queue'!A1");
  const r = await fetch(
    SPREADSHEETS + '/' + encodeURIComponent(spreadsheetId) + '/values/' + writeRange + '?valueInputOption=RAW',
    {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ range: "'Automation Queue'!A1", majorDimension: 'ROWS', values: [['record_id']] }),
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error('Service-account write permission failed: ' + (detail?.error?.message || r.status) +
      '. Share the tracker as Editor with ' + key.client_email + '.');
  }
}

function saveConfig(keySource, spreadsheetId) {
  const base = path.join(process.env.APPDATA, 'JobFinder');
  const secrets = path.join(base, 'secrets');
  const destination = path.join(secrets, 'google-service-account.json');
  const cfgFile = path.join(base, 'JobFinder.env.cmd');
  fs.mkdirSync(secrets, { recursive: true });

  // Keep the raw key out of the distributed installation and source repository.
  fs.copyFileSync(keySource, destination);
  try { fs.chmodSync(destination, 0o600); } catch {}

  const existing = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '@echo off\r\n';
  if (fs.existsSync(cfgFile)) {
    fs.copyFileSync(cfgFile, cfgFile + '.pre-service-account.bak');
  }
  let lines = existing.split(/\r?\n/).filter(Boolean).filter((line) =>
    !/^set "(?:JOBFINDER_SERVICE_ACCOUNT_KEY_FILE|JOBFINDER_TRACKER_SPREADSHEET_ID)=/i.test(line)
  );
  lines.push('set "JOBFINDER_TRACKER_SPREADSHEET_ID=' + spreadsheetId + '"');
  lines.push('set "JOBFINDER_SERVICE_ACCOUNT_KEY_FILE=' + destination + '"');
  if (!lines.some((l) => /^set "JOBFINDER_TRACKER_TAB=/i.test(l))) {
    lines.push('set "JOBFINDER_TRACKER_TAB=Automation Queue"');
  }
  if (!lines.some((l) => /^set "JOBFINDER_INTERVENTION_TAB=/i.test(l))) {
    lines.push('set "JOBFINDER_INTERVENTION_TAB=Interventions"');
  }
  const tmp = cfgFile + '.tmp';
  fs.writeFileSync(tmp, lines.join('\r\n') + '\r\n', { mode: 0o600 });
  fs.renameSync(tmp, cfgFile);
  return { destination, cfgFile };
}

async function main() {
  if (process.argv.includes('--self-test')) {
    if (!parseSheet('https://docs.google.com/spreadsheets/d/1FEI75MC79pCiriiToUpbHTNaKeGokUpuxdA2mTLC-4E/edit')) {
      throw new Error('Sheet URL parser failed.');
    }
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const private_key = kp.privateKey.export({ format: 'pem', type: 'pkcs8' });
    const jwt = signedAssertion({ client_email: 'test@myproject.iam.gserviceaccount.com', private_key });
    const [head, body, sig] = jwt.split('.');
    if (!crypto.verify('RSA-SHA256', Buffer.from(head + '.' + body), kp.publicKey, Buffer.from(sig, 'base64url'))) {
      throw new Error('Service account signature self-test failed.');
    }
    console.log('Service account configuration self-test passed.');
    return;
  }
  if (process.platform !== 'win32' || !process.env.APPDATA) {
    throw new Error('Use this helper in the packaged JobFinder Windows installation.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n==========================================================');
    console.log(' JobFinder - Durable Google Sheets Connection');
    console.log('==========================================================\n');
    console.log('First create a Google Cloud service account and download its JSON key.');
    const raw = (await rl.question('Path to downloaded service-account JSON file: ')).trim();
    const keyPath = path.resolve(raw.replace(/^["']|["']$/g, ''));
    if (!fs.existsSync(keyPath)) throw new Error('JSON file not found: ' + keyPath);
    const key = parseKey(keyPath);
    console.log('\nGoogle service account email: ' + key.client_email);
    console.log('Open the JobFinder Master Tracker, click Share, add the email above as Editor.');
    await rl.question('Press Enter after sharing the Sheet with that email: ');

    const sheetInput = await rl.question('Paste the JobFinder Master Tracker URL or spreadsheet ID: ');
    const spreadsheetId = parseSheet(sheetInput);
    if (!spreadsheetId) throw new Error('Invalid Google Spreadsheet URL or ID.');

    console.log('Checking Google Sheets authorization and both tracker tabs...');
    await verifySheetAccess(key, spreadsheetId);
    const paths = saveConfig(keyPath, spreadsheetId);
    console.log('\nSERVICE ACCOUNT CONNECTED');
    console.log('Both tracker tabs verified.');
    console.log('Google credentials saved locally: ' + paths.destination);
    console.log('Configuration saved: ' + paths.cfgFile);
    console.log('Next: restart the JobFinder server/watchdog so it loads the new configuration.');
    console.log('Existing OAuth settings and tracker data remain intact.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('\n[X] Service-account setup failed: ' + (error?.message || error));
  console.error('No new credential is activated unless Google Sheet verification succeeds.');
  process.exitCode = 1;
});
