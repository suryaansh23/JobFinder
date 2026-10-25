import fs from 'node:fs';
import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';

let tokenCache = null;

function env(name) {
  return String(process.env[name] || '').trim();
}

export function sheetsConfig() {
  return {
    spreadsheetId: env('JOBFINDER_TRACKER_SPREADSHEET_ID'),
    tab: env('JOBFINDER_TRACKER_TAB') || 'Automation Queue',
    interventionTab: env('JOBFINDER_INTERVENTION_TAB') || 'Interventions',
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
    serviceAccountKeyFile: env('JOBFINDER_SERVICE_ACCOUNT_KEY_FILE'),
  };
}

export function sheetsConfigured() {
  const c = sheetsConfig();
  return !!(c.spreadsheetId &&
    (c.serviceAccountKeyFile || (c.clientId && c.clientSecret && c.refreshToken)));
}

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;

  const c = sheetsConfig();
  let body;
  let method;
  if (c.serviceAccountKeyFile) {
    // A dedicated service account is suitable for the user's single shared tracker.
    // Unlike an external OAuth app in Testing mode, it needs no expiring refresh token.
    let key;
    try {
      key = JSON.parse(fs.readFileSync(c.serviceAccountKeyFile, 'utf8'));
    } catch (e) {
      throw new Error(`Could not read JobFinder service-account key: ${e.message}`);
    }
    if (key.type !== 'service_account' || !key.client_email || !key.private_key ||
        key.token_uri !== TOKEN_URL) {
      throw new Error('Invalid service-account key: expected a Google service-account JSON file.');
    }
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = [
      encode({ alg: 'RS256', typ: 'JWT' }),
      encode({
        iss: key.client_email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    ].join('.');
    const signed = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signed}`,
    });
    method = 'service-account';
  } else {
    if (!c.clientId || !c.clientSecret || !c.refreshToken) {
      throw new Error('Google Sheets credentials are not configured.');
    }
    body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    });
    method = 'oauth';
  }

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const explanation = j.error_description || j.error || r.status;
    throw new Error(`Google ${method} token request failed: ${explanation}`);
  }

  tokenCache = {
    value: j.access_token,
    expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000,
  };
  return tokenCache.value;
}

async function api(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const r = await fetch(`${SHEETS_ROOT}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || j?.error || `HTTP ${r.status}`;
    throw new Error(`Google Sheets API failed: ${msg}`);
  }
  return j;
}

function quotedTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

export async function ensureSheetTab(tabName) {
  const c = sheetsConfig();
  const tab = tabName || c.tab;
  if (!c.spreadsheetId) throw new Error('JOBFINDER_TRACKER_SPREADSHEET_ID is not configured.');

  const meta = await api(`${encodeURIComponent(c.spreadsheetId)}?fields=sheets.properties`);
  const found = (meta.sheets || []).find((s) => s?.properties?.title === tab);
  if (found) return found.properties;

  const created = await api(`${encodeURIComponent(c.spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
  return created.replies?.[0]?.addSheet?.properties || { title: tab };
}

export async function readValues(a1Range, tabName) {
  const c = sheetsConfig();
  const tab = tabName || c.tab;
  const range = encodeURIComponent(`${quotedTab(tab)}!${a1Range}`);
  const j = await api(`${encodeURIComponent(c.spreadsheetId)}/values/${range}?majorDimension=ROWS`);
  return j.values || [];
}

export async function writeValues(a1Range, values, tabName) {
  const c = sheetsConfig();
  const tab = tabName || c.tab;
  const range = encodeURIComponent(`${quotedTab(tab)}!${a1Range}`);
  return api(`${encodeURIComponent(c.spreadsheetId)}/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: { majorDimension: 'ROWS', values },
  });
}

export async function batchWriteValues(updates, tabName) {
  if (!updates.length) return { totalUpdatedRows: 0 };
  const c = sheetsConfig();
  const tab = tabName || c.tab;
  return api(`${encodeURIComponent(c.spreadsheetId)}/values:batchUpdate`, {
    method: 'POST',
    body: {
      valueInputOption: 'USER_ENTERED',
      data: updates.map((u) => ({
        range: `${quotedTab(u.tab || tab)}!${u.range}`,
        majorDimension: 'ROWS',
        values: u.values,
      })),
    },
  });
}
