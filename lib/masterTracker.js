import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { ensureSheetTab, readValues, writeValues, batchWriteValues, sheetsConfigured, sheetsConfig } from './googleSheetsClient.js';
import { detectAts } from './atsDetector.js';

export const TRACKER_HEADERS = [
  'record_id',
  'job_id',
  'queued_at',
  'company',
  'role',
  'location',
  'source',
  'url',
  'priority',
  'status',
  'apply_channel',
  'cv',
  'confirmation',
  'application_reference',
  'applied_at',
  'action_required',
  'action_reason',
  'last_attempt_at',
  'attempts',
  'notes',
];

export const TRACKER_STATUS = Object.freeze({
  NOT_APPLIED: 'NOT_APPLIED',
  RUNNING: 'RUNNING',
  DRY_RUN_OK: 'DRY_RUN_OK',
  ATS_QUEUED: 'ATS_QUEUED',
  APPLIED: 'APPLIED',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  FAILED: 'FAILED',
  HOLD: 'HOLD',
  SKIPPED: 'SKIPPED',
});

const HEADER_INDEX = Object.fromEntries(TRACKER_HEADERS.map((h, i) => [h, i]));

function cell(row, key) {
  return row[HEADER_INDEX[key]] ?? '';
}

function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}


function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isoOrMillis(v) {
  if (!v) return 0;
  const direct = Number(v);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : 0;
}

function connectorFrom(row) {
  const source = String(row.source || '').toLowerCase();
  const url = String(row.url || '').toLowerCase();
  if (source.includes('linkedin') || url.includes('linkedin.com/')) return 'linkedin';
  if (source.includes('naukri') || url.includes('naukri.com/')) return 'naukri';
  return 'tracker';
}

function pipelineStatus(status) {
  switch (status) {
    case TRACKER_STATUS.APPLIED: return 'applied';
    case TRACKER_STATUS.FAILED: return 'error';
    case TRACKER_STATUS.SKIPPED:
    case TRACKER_STATUS.HOLD: return 'skipped';
    case TRACKER_STATUS.RUNNING: return 'in_progress';
    default: return 'new';
  }
}

function normaliseStatus(v) {
  const s = String(v || '').trim().toUpperCase().replace(/[ -]+/g, '_');
  return Object.values(TRACKER_STATUS).includes(s) ? s : TRACKER_STATUS.NOT_APPLIED;
}

function rowObject(values, sheetRow) {
  const row = Object.fromEntries(TRACKER_HEADERS.map((h) => [h, cell(values, h)]));
  row.sheet_row = sheetRow;
  row.status = normaliseStatus(row.status);
  row.priority = num(row.priority, 0);
  row.attempts = num(row.attempts, 0);
  row.queued_at_ms = isoOrMillis(row.queued_at);
  return row;
}

export async function trackerReady() {
  return {
    configured: sheetsConfigured(),
    spreadsheetId: sheetsConfig().spreadsheetId || null,
    tab: sheetsConfig().tab,
  };
}

export async function ensureTrackerLayout() {
  if (!sheetsConfigured()) throw new Error('Google Sheets tracker is not configured.');
  await ensureSheetTab();
  const top = await readValues('A1:T2');
  const header = top[0] || [];
  const exact = TRACKER_HEADERS.every((h, i) => String(header[i] || '').trim() === h);
  if (!exact) {
    const empty = !header.some((x) => String(x || '').trim());
    if (!empty) {
      throw new Error('Tracker header does not match the JobFinder Automation Queue schema.');
    }
    await writeValues('A1:T1', [TRACKER_HEADERS]);
  }
  return true;
}

export async function readTrackerRows() {
  await ensureTrackerLayout();
  const values = await readValues('A1:T5000');
  if (values.length <= 1) return [];
  return values.slice(1).map((r, i) => rowObject(r, i + 2)).filter((r) =>
    r.record_id || r.job_id || r.url || r.company || r.role
  );
}

export function selectLifoRows(rows, limit = 10, { armed = false } = {}) {
  const eligible = armed
    ? [TRACKER_STATUS.NOT_APPLIED, TRACKER_STATUS.DRY_RUN_OK]
    : [TRACKER_STATUS.NOT_APPLIED];
  return rows
    .filter((r) => {
      if (eligible.includes(r.status)) return true;
      if (r.status !== TRACKER_STATUS.ATS_QUEUED) return false;
      const provider = detectAts(r.url || '').key;
      return provider === 'greenhouse' || provider === 'lever';
    })
    .sort((a, b) => {
      const aq = a.queued_at_ms || 0;
      const bq = b.queued_at_ms || 0;
      if (aq !== bq) return bq - aq;
      return b.sheet_row - a.sheet_row;
    })
    .slice(0, Math.max(1, Number(limit) || 10));
}

async function ensureMirrorTable() {
  await run(`CREATE TABLE IF NOT EXISTS orchestrator_rows (
    record_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    job_id TEXT,
    sheet_row INTEGER NOT NULL,
    tracker_status TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    attempts INTEGER DEFAULT 0,
    note TEXT
  )`);
  await run('CREATE INDEX IF NOT EXISTS orchestrator_rows_profile ON orchestrator_rows(profile_id, sheet_row)');
}

function stableExternalId(row) {
  if (row.record_id) return row.record_id;
  if (row.job_id) return row.job_id;
  if (row.url) return crypto.createHash('sha1').update(row.url).digest('hex');
  return crypto.randomUUID();
}

export async function syncTrackerRows(profileId, rows) {
  await ensureMirrorTable();
  const now = Date.now();
  const updates = [];
  const synced = [];

  for (const row of rows) {
    let job = null;
    if (row.job_id) job = await get('SELECT * FROM jobs WHERE id = ? AND profile_id = ?', [row.job_id, profileId]);
    if (!job && row.url) job = await get('SELECT * FROM jobs WHERE profile_id = ? AND url = ? ORDER BY discovered_at DESC LIMIT 1', [profileId, row.url]);

    if (!job) {
      const jobId = crypto.randomUUID();
      const connector = connectorFrom(row);
      await run(
        `INSERT INTO jobs
          (id, profile_id, connector, external_id, title, company, location, url, status, discovered_at, apply_kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          jobId,
          profileId,
          connector,
          stableExternalId(row),
          row.role || '',
          row.company || '',
          row.location || '',
          row.url || '',
          pipelineStatus(row.status),
          row.queued_at_ms || now,
          connector === 'tracker' ? 'external' : null,
        ]
      );
      job = await get('SELECT * FROM jobs WHERE id = ?', [jobId]);
    } else {
      const desired = pipelineStatus(row.status);
      await run(
        `UPDATE jobs SET
          title = COALESCE(NULLIF(?, ''), title),
          company = COALESCE(NULLIF(?, ''), company),
          location = COALESCE(NULLIF(?, ''), location),
          url = COALESCE(NULLIF(?, ''), url),
          status = CASE WHEN ? IN ('applied','error','skipped') THEN ? ELSE status END
         WHERE id = ?`,
        [row.role || '', row.company || '', row.location || '', row.url || '', desired, desired, job.id]
      );
      job = await get('SELECT * FROM jobs WHERE id = ?', [job.id]);
    }

    if ((job.auto_apply_state === 'applied' || job.status === 'applied') && row.status !== TRACKER_STATUS.APPLIED) {
      row.status = TRACKER_STATUS.APPLIED;
      row.applied_at = row.applied_at || new Date(job.auto_applied_at || job.applied_at || now).toISOString();
      row.confirmation = row.confirmation || 'Reconciled from JobFinder: application is already recorded as applied.';
      updates.push({ range: `J${row.sheet_row}:J${row.sheet_row}`, values: [[TRACKER_STATUS.APPLIED]] });
      updates.push({ range: `M${row.sheet_row}:M${row.sheet_row}`, values: [[row.confirmation]] });
      updates.push({ range: `O${row.sheet_row}:O${row.sheet_row}`, values: [[row.applied_at]] });
    } else if (job.auto_apply_state === 'submit_clicked' && row.status !== TRACKER_STATUS.ACTION_REQUIRED) {
      row.status = TRACKER_STATUS.ACTION_REQUIRED;
      row.action_required = 'YES';
      row.action_reason = 'JobFinder recorded a submit click without confirmation. Reconcile manually before retrying.';
      updates.push({ range: `J${row.sheet_row}:J${row.sheet_row}`, values: [[TRACKER_STATUS.ACTION_REQUIRED]] });
      updates.push({ range: `P${row.sheet_row}:Q${row.sheet_row}`, values: [['YES', row.action_reason]] });
    }

    const recordId = row.record_id || `JF-${job.id.slice(0, 8)}`;
    await run(
      `INSERT INTO orchestrator_rows
        (record_id, profile_id, job_id, sheet_row, tracker_status, last_seen_at, attempts)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(record_id) DO UPDATE SET
         profile_id = ?, job_id = ?, sheet_row = ?, tracker_status = ?, last_seen_at = ?`,
      [
        recordId, profileId, job.id, row.sheet_row, row.status, now, row.attempts || 0,
        profileId, job.id, row.sheet_row, row.status, now,
      ]
    );

    if (!row.record_id || !row.job_id) {
      updates.push({
        range: `A${row.sheet_row}:B${row.sheet_row}`,
        values: [[recordId, job.id]],
      });
    }

    synced.push({ ...row, record_id: recordId, job_id: job.id, connector: job.connector, apply_kind: job.apply_kind });
  }

  if (updates.length) await batchWriteValues(updates);
  return synced;
}

export async function updateTrackerRow(row, patch) {
  const merged = { ...row, ...patch };
  const updates = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in HEADER_INDEX)) continue;
    const col = columnLetter(HEADER_INDEX[key]);
    updates.push({ range: `${col}${row.sheet_row}:${col}${row.sheet_row}`, values: [[value ?? '']] });
  }
  if (updates.length) await batchWriteValues(updates);

  if (merged.record_id) {
    await ensureMirrorTable();
    await run(
      `UPDATE orchestrator_rows SET tracker_status = ?, last_attempt_at = ?, attempts = ?, note = ?
       WHERE record_id = ?`,
      [
        normaliseStatus(merged.status),
        isoOrMillis(merged.last_attempt_at) || null,
        num(merged.attempts, 0),
        String(merged.action_reason || merged.notes || '').slice(0, 1000),
        merged.record_id,
      ]
    );
  }
  return merged;
}

export async function recoverStaleRunningRows(rows, staleMs = 30 * 60 * 1000) {
  const now = Date.now();
  const recovered = [];
  for (const row of rows) {
    if (row.status !== TRACKER_STATUS.RUNNING) continue;
    const last = isoOrMillis(row.last_attempt_at);
    if (last && now - last < staleMs) continue;
    const next = await updateTrackerRow(row, {
      status: TRACKER_STATUS.ACTION_REQUIRED,
      action_required: 'YES',
      action_reason: 'A previous run stopped before recording a final result. Reconcile this application before any retry.',
    });
    recovered.push(next);
  }
  return recovered;
}

export async function trackerStats(profileId) {
  await ensureMirrorTable();
  const rows = await all(
    'SELECT tracker_status, COUNT(*) AS n FROM orchestrator_rows WHERE profile_id = ? GROUP BY tracker_status',
    [profileId]
  );
  return Object.fromEntries(rows.map((r) => [r.tracker_status, r.n]));
}
