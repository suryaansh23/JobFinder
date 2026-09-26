import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

const FILE = dataPath('tracker.json');

function cleanId(value = '') {
  const s = String(value || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : s;
}

export function readTrackerConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      spreadsheetId: cleanId(j.spreadsheetId || ''),
      tab: String(j.tab || 'Automation Queue').trim() || 'Automation Queue',
    };
  } catch {
    return { spreadsheetId: '', tab: 'Automation Queue' };
  }
}

export function saveTrackerConfig({ spreadsheetId, spreadsheetUrl, tab } = {}) {
  const current = readTrackerConfig();
  const next = {
    spreadsheetId: cleanId(spreadsheetId || spreadsheetUrl || current.spreadsheetId),
    tab: String(tab || current.tab || 'Automation Queue').trim() || 'Automation Queue',
  };
  if (!next.spreadsheetId) throw new Error('Google Sheet URL or spreadsheet ID is required.');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch {}
  return next;
}

export function trackerConfigStatus() {
  const c = readTrackerConfig();
  return { configured: !!c.spreadsheetId, ...c };
}
