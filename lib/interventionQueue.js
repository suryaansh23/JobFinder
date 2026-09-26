import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { upsertAnswer } from './answerBank.js';
import { readTrackerRows, updateTrackerRow, TRACKER_STATUS } from './masterTracker.js';

async function ensureTable() {
  await run(`CREATE TABLE IF NOT EXISTS interventions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    job_id TEXT,
    kind TEXT NOT NULL,
    question_key TEXT,
    prompt TEXT NOT NULL,
    options_json TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  )`);
  await run('CREATE INDEX IF NOT EXISTS interventions_profile_state ON interventions(profile_id, state, created_at)');
}

export async function createIntervention(profileId, {
  jobId = null, kind = 'human_required', questionKey = null, prompt, options = null,
} = {}) {
  await ensureTable();
  const existing = await get(
    `SELECT * FROM interventions
      WHERE profile_id = ? AND COALESCE(job_id, '') = COALESCE(?, '')
        AND kind = ? AND COALESCE(question_key, '') = COALESCE(?, '')
        AND state = 'open'
      ORDER BY created_at DESC LIMIT 1`,
    [profileId, jobId, kind, questionKey]
  );
  if (existing) return existing;

  const id = crypto.randomUUID();
  await run(
    `INSERT INTO interventions
      (id, profile_id, job_id, kind, question_key, prompt, options_json, state, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, profileId, jobId, kind, questionKey, String(prompt || kind).slice(0, 2000),
      options ? JSON.stringify(options) : null, 'open', Date.now()]
  );
  return get('SELECT * FROM interventions WHERE id = ?', [id]);
}

export async function listInterventions(profileId, { state = 'open', limit = 100 } = {}) {
  await ensureTable();
  const params = [profileId];
  let where = 'i.profile_id = ?';
  if (state && state !== 'all') { where += ' AND i.state = ?'; params.push(state); }
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const rows = await all(
    `SELECT i.*, j.title AS job_title, j.company AS job_company, j.url AS job_url, j.connector AS job_connector
       FROM interventions i
       LEFT JOIN jobs j ON j.id = i.job_id
      WHERE ${where}
      ORDER BY i.created_at DESC LIMIT ?`,
    params
  );
  return rows.map((r) => ({
    ...r,
    options: (() => { try { return r.options_json ? JSON.parse(r.options_json) : null; } catch { return null; } })(),
  }));
}

async function requeueTrackerJob(profileId, jobId) {
  if (!jobId) return null;
  const job = await get('SELECT * FROM jobs WHERE id = ? AND profile_id = ?', [jobId, profileId]);
  if (!job) return null;
  const rows = await readTrackerRows();
  const row = rows.find((r) => r.job_id === jobId);
  if (!row) return null;
  const ats = row.apply_channel === 'ATS' || job.connector === 'tracker' || job.apply_kind === 'external';
  return updateTrackerRow(row, {
    status: ats ? TRACKER_STATUS.ATS_QUEUED : TRACKER_STATUS.NOT_APPLIED,
    action_required: '',
    action_reason: '',
  });
}

export async function resolveIntervention(profileId, id, { answer, resolution, requeue = true, outcome = null } = {}) {
  await ensureTable();
  const item = await get('SELECT * FROM interventions WHERE id = ? AND profile_id = ?', [id, profileId]);
  if (!item) throw new Error('intervention not found');
  if (item.state !== 'open') return item;

  if (item.question_key && String(answer || '').trim()) {
    await upsertAnswer(profileId, item.question_key, String(answer).trim(), item.prompt || item.question_key);
  }
  await run(
    `UPDATE interventions SET state = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?`,
    [Date.now(), String(resolution || answer || outcome || 'resolved').slice(0, 2000), id]
  );

  if (outcome === 'applied' && item.job_id) {
    const now = Date.now();
    await run(
      `UPDATE jobs SET status = 'applied', auto_apply_state = 'applied',
        auto_apply_note = ?, auto_applied_at = ?, applied_at = COALESCE(applied_at, ?), status_changed_at = ?
       WHERE id = ? AND profile_id = ?`,
      ['Manually confirmed applied during intervention reconciliation', now, now, now, item.job_id, profileId]
    );
    const rows = await readTrackerRows();
    const row = rows.find((r) => r.job_id === item.job_id);
    if (row) await updateTrackerRow(row, {
      status: TRACKER_STATUS.APPLIED,
      applied_at: new Date(now).toISOString(),
      confirmation: 'Manually confirmed applied',
      action_required: '',
      action_reason: '',
    });
  } else if (outcome === 'skipped' && item.job_id) {
    await run(
      `UPDATE jobs SET status = 'skipped', status_changed_at = ? WHERE id = ? AND profile_id = ?`,
      [Date.now(), item.job_id, profileId]
    );
    const rows = await readTrackerRows();
    const row = rows.find((r) => r.job_id === item.job_id);
    if (row) await updateTrackerRow(row, {
      status: TRACKER_STATUS.SKIPPED,
      action_required: '',
      action_reason: String(resolution || 'Skipped during intervention').slice(0, 1000),
    });
  } else if (outcome === 'retry' || requeue) {
    await requeueTrackerJob(profileId, item.job_id).catch(() => null);
  }

  return get('SELECT * FROM interventions WHERE id = ?', [id]);
}
