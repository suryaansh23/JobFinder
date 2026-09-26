import { googleAccessToken, gmailStatus } from './gmail.js';
import { readTrackerConfig } from './trackerConfig.js';

const SHEETS_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';

export function sheetsConfig() {
  return readTrackerConfig();
}

export function sheetsConfigured() {
  const c = sheetsConfig();
  return !!(c.spreadsheetId && gmailStatus().connected);
}

async function api(path, { method = 'GET', body } = {}) {
  const token = await googleAccessToken();
  const r = await fetch(`${SHEETS_ROOT}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || j?.error || `HTTP ${r.status}`;
    if (r.status === 403 && /scope|permission|insufficient/i.test(String(msg))) {
      throw new Error('Google Sheets permission is missing. Reconnect Google in JobFinder once to grant tracker access.');
    }
    throw new Error(`Google Sheets API failed: ${msg}`);
  }
  return j;
}

function quotedTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

export async function ensureSheetTab() {
  const c = sheetsConfig();
  if (!c.spreadsheetId) throw new Error('Tracker Google Sheet is not configured.');

  const meta = await api(`${encodeURIComponent(c.spreadsheetId)}?fields=sheets.properties`);
  const found = (meta.sheets || []).find((s) => s?.properties?.title === c.tab);
  if (found) return found.properties;

  const created = await api(`${encodeURIComponent(c.spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: { requests: [{ addSheet: { properties: { title: c.tab } } }] },
  });
  return created.replies?.[0]?.addSheet?.properties || { title: c.tab };
}

export async function readValues(a1Range) {
  const c = sheetsConfig();
  const range = encodeURIComponent(`${quotedTab(c.tab)}!${a1Range}`);
  const j = await api(`${encodeURIComponent(c.spreadsheetId)}/values/${range}?majorDimension=ROWS`);
  return j.values || [];
}

export async function writeValues(a1Range, values) {
  const c = sheetsConfig();
  const range = encodeURIComponent(`${quotedTab(c.tab)}!${a1Range}`);
  return api(`${encodeURIComponent(c.spreadsheetId)}/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: { majorDimension: 'ROWS', values },
  });
}

export async function batchWriteValues(updates) {
  if (!updates.length) return { totalUpdatedRows: 0 };
  const c = sheetsConfig();
  return api(`${encodeURIComponent(c.spreadsheetId)}/values:batchUpdate`, {
    method: 'POST',
    body: {
      valueInputOption: 'USER_ENTERED',
      data: updates.map((u) => ({
        range: `${quotedTab(c.tab)}!${u.range}`,
        majorDimension: 'ROWS',
        values: u.values,
      })),
    },
  });
}
