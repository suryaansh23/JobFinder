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
  };
}

export function sheetsConfigured() {
  const c = sheetsConfig();
  return !!(c.spreadsheetId && c.clientId && c.clientSecret && c.refreshToken);
}

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;

  const c = sheetsConfig();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    throw new Error('Google Sheets credentials are not configured.');
  }

  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token',
  });

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Google token refresh failed: ${j.error_description || j.error || r.status}`);
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
