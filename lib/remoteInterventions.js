import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { listNeedsInput, upsertAnswer } from './answerBank.js';
import {
  sheetsConfig,
  ensureSheetTab,
  readValues,
  writeValues,
  batchWriteValues,
} from './googleSheetsClient.js';

export const INTERVENTION_HEADERS = [
  'intervention_id',
  'profile_id',
  'field_key',
  'job_id',
  'company',
  'role',
  'question',
  'type',
  'options',
  'answer',
  'status',
  'asked_at',
  'resolved_at',
];

function stableId(profileId, fieldKey) {
  return crypto.createHash('sha1').update(`${profileId}:${fieldKey}`).digest('hex').slice(0, 20);
}

function value(row, index) {
  return String(row[index] ?? '').trim();
}

async function ensureLayout() {
  const tab = sheetsConfig().interventionTab;
  await ensureSheetTab(tab);
  const top = await readValues('A1:M2', tab);
  const header = top[0] || [];
  const exact = INTERVENTION_HEADERS.every((h, i) => String(header[i] || '').trim() === h);
  if (!exact) {
    if (header.some((x) => String(x || '').trim())) {
      throw new Error('Interventions tab header does not match the JobFinder schema.');
    }
    await writeValues('A1:M1', [INTERVENTION_HEADERS], tab);
  }
  return tab;
}

function parseRows(values) {
  return values.slice(1).map((row, i) => ({
    sheet_row: i + 2,
    intervention_id: value(row, 0),
    profile_id: value(row, 1),
    field_key: value(row, 2),
    job_id: value(row, 3),
    company: value(row, 4),
    role: value(row, 5),
    question: value(row, 6),
    type: value(row, 7),
    options: value(row, 8),
    answer: value(row, 9),
    status: value(row, 10).toUpperCase(),
    asked_at: value(row, 11),
    resolved_at: value(row, 12),
  })).filter((r) => r.field_key || r.intervention_id);
}

async function jobContext(jobId) {
  if (!jobId) return null;
  return get('SELECT id, company, title FROM jobs WHERE id = ?', [jobId]).catch(() => null);
}

async function importRemoteAnswers(profileId, rows, tab) {
  let imported = 0;
  const updates = [];

  for (const row of rows) {
    if (row.profile_id !== profileId || !row.field_key) continue;
    if (!row.answer || row.status === 'RESOLVED') continue;

    await upsertAnswer(profileId, row.field_key, row.answer, row.question || row.field_key);
    imported++;

    updates.push({
      range: `K${row.sheet_row}:M${row.sheet_row}`,
      values: [['RESOLVED', row.asked_at || new Date().toISOString(), new Date().toISOString()]],
    });
  }

  if (updates.length) await batchWriteValues(updates, tab);
  return imported;
}

async function exportWaitingQuestions(profileId, rows, tab) {
  const byKey = new Map(
    rows
      .filter((r) => r.profile_id === profileId && r.field_key)
      .map((r) => [r.field_key, r])
  );
  const waiting = await listNeedsInput(profileId);
  let nextRow = Math.max(2, rows.reduce((m, r) => Math.max(m, r.sheet_row + 1), 2));
  const updates = [];
  let added = 0;

  for (const q of waiting) {
    if (!q.field_key) continue;
    const job = await jobContext(q.asked_by);
    const askedAt = q.asked_at ? new Date(Number(q.asked_at)).toISOString() : new Date().toISOString();
    const existing = byKey.get(q.field_key);

    if (existing) {
      // A previously resolved question can become unknown again — commonly when a
      // dropdown presents different allowed choices at another employer. Re-open the
      // same row, clear the stale answer, and refresh the context instead of silently
      // hiding the new blocker behind an old RESOLVED state.
      if (existing.status !== 'WAITING' || existing.answer) {
        updates.push({
          range: `D${existing.sheet_row}:M${existing.sheet_row}`,
          values: [[
            q.asked_by || '',
            job?.company || '',
            job?.title || '',
            q.label || q.field_key,
            q.type || 'text',
            q.options ? JSON.stringify(q.options) : '',
            '',
            'WAITING',
            askedAt,
            '',
          ]],
        });
      }
      continue;
    }

    updates.push({
      range: `A${nextRow}:M${nextRow}`,
      values: [[
        stableId(profileId, q.field_key),
        profileId,
        q.field_key,
        q.asked_by || '',
        job?.company || '',
        job?.title || '',
        q.label || q.field_key,
        q.type || 'text',
        q.options ? JSON.stringify(q.options) : '',
        '',
        'WAITING',
        askedAt,
        '',
      ]],
    });
    nextRow++;
    added++;
  }

  if (updates.length) await batchWriteValues(updates, tab);
  return added;
}

async function requeueAnsweredJobs(profileId, tab) {
  const waiting = new Set(
    (await all(
      "SELECT field_key FROM answers WHERE profile_id = ? AND status = 'needs_input'",
      [profileId]
    )).map((r) => r.field_key)
  );

  const jobs = await all(
    `SELECT id, auto_apply_blocked_on
       FROM jobs
      WHERE profile_id = ?
        AND auto_apply_state = 'needs_input'
        AND auto_apply_blocked_on IS NOT NULL`,
    [profileId]
  );

  let requeued = 0;
  const sheetUpdates = [];

  for (const job of jobs) {
    let blocked = [];
    try { blocked = JSON.parse(job.auto_apply_blocked_on || '[]'); } catch { blocked = []; }
    if (!blocked.length || blocked.some((k) => waiting.has(k))) continue;

    const mirror = await get(
      'SELECT sheet_row, tracker_status FROM orchestrator_rows WHERE profile_id = ? AND job_id = ?',
      [profileId, job.id]
    );
    if (!mirror || mirror.tracker_status !== 'ACTION_REQUIRED') continue;

    await run(
      "UPDATE orchestrator_rows SET tracker_status = 'NOT_APPLIED', note = ? WHERE profile_id = ? AND job_id = ?",
      ['Remote question answered; queued to retry.', profileId, job.id]
    );

    sheetUpdates.push(
      { range: `J${mirror.sheet_row}:J${mirror.sheet_row}`, values: [['NOT_APPLIED']] },
      { range: `P${mirror.sheet_row}:Q${mirror.sheet_row}`, values: [['', 'Remote question answered; queued to retry.']] }
    );
    requeued++;
  }

  if (sheetUpdates.length) await batchWriteValues(sheetUpdates, sheetsConfig().tab);
  return requeued;
}

export async function syncRemoteInterventions(profileId) {
  const tab = await ensureLayout();
  let values = await readValues('A1:M5000', tab);
  let rows = parseRows(values);

  const imported = await importRemoteAnswers(profileId, rows, tab);

  // Re-read because imported rows were just marked RESOLVED.
  if (imported) {
    values = await readValues('A1:M5000', tab);
    rows = parseRows(values);
  }

  const exported = await exportWaitingQuestions(profileId, rows, tab);
  const requeued = await requeueAnsweredJobs(profileId, tab);

  return { imported, exported, requeued, tab };
}
