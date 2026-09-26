import { get, run } from './db.js';
import { guardedAutoApplyRun } from './guardedAutoApply.js';
import { runAtsBatch } from './atsEngine.js';
import { createIntervention } from './interventionQueue.js';
import { acquireLease, renewLease, releaseLease } from './runtimeLease.js';
import {
  TRACKER_STATUS,
  readTrackerRows,
  selectLifoRows,
  syncTrackerRows,
  updateTrackerRow,
  recoverStaleRunningRows,
  trackerReady,
  trackerStats,
} from './masterTracker.js';
import {
  beginOrchestratorRun,
  finishOrchestratorRun,
  failOrchestratorRun,
  recentOrchestratorRuns,
} from './orchestratorStore.js';

function nowIso() { return new Date().toISOString(); }

function isAtsRow(row, job) {
  return row.status === TRACKER_STATUS.ATS_QUEUED
    || row.status === TRACKER_STATUS.ATS_READY
    || row.apply_channel === 'ATS'
    || job.connector === 'tracker'
    || job.apply_kind === 'external';
}

function boardPatch(row, result, armed) {
  const attempts = (Number(row.attempts) || 0) + 1;
  const base = { last_attempt_at: nowIso(), attempts, confirmation: result.note || '', action_required: '', action_reason: '' };
  switch (result.state) {
    case 'applied':
    case 'already_applied':
      return { ...base, status: TRACKER_STATUS.APPLIED, applied_at: row.applied_at || nowIso(), confirmation: result.note || 'Application confirmed' };
    case 'submit_clicked':
      return { ...base, status: TRACKER_STATUS.ACTION_REQUIRED, action_required: 'YES', action_reason: 'Submission was clicked but confirmation was not observed. Reconcile manually before retrying.' };
    case 'needs_input':
    case 'applied_incomplete':
      return { ...base, status: TRACKER_STATUS.ACTION_REQUIRED, action_required: 'YES', action_reason: result.note || 'Application needs user input.' };
    case 'abandoned':
      return { ...base, status: TRACKER_STATUS.FAILED, action_required: 'YES', action_reason: result.note || 'Retry limit reached.' };
    case 'expired':
      return { ...base, status: TRACKER_STATUS.SKIPPED, action_reason: result.note || 'Listing expired.' };
    case 'external':
    case 'unsupported':
      return { ...base, status: TRACKER_STATUS.ATS_QUEUED, apply_channel: 'ATS', action_reason: result.note || 'Queued for external ATS automation.' };
    case 'dry_run':
      return { ...base, status: TRACKER_STATUS.DRY_RUN_OK, confirmation: result.note || 'Dry run completed.' };
    case 'error':
      return { ...base, status: row.status === TRACKER_STATUS.DRY_RUN_OK ? TRACKER_STATUS.DRY_RUN_OK : TRACKER_STATUS.NOT_APPLIED, action_reason: result.note || 'Attempt failed; remains queued for retry.' };
    default:
      return { ...base, status: armed ? TRACKER_STATUS.NOT_APPLIED : TRACKER_STATUS.DRY_RUN_OK };
  }
}

function atsPatch(row, result) {
  const attempts = (Number(row.attempts) || 0) + 1;
  const base = {
    last_attempt_at: nowIso(), attempts, apply_channel: 'ATS',
    confirmation: result.note || '', action_required: '', action_reason: '',
  };
  switch (result.state) {
    case 'ats_ready':
      return { ...base, status: TRACKER_STATUS.ATS_READY, confirmation: result.note || 'ATS dry run complete and ready for live submission.' };
    case 'applied':
      return { ...base, status: TRACKER_STATUS.APPLIED, applied_at: nowIso(), confirmation: result.note || 'ATS application confirmed.' };
    case 'submit_clicked':
      return { ...base, status: TRACKER_STATUS.ACTION_REQUIRED, action_required: 'YES', action_reason: result.note || 'ATS submit was clicked without confirmation.' };
    case 'needs_input':
    case 'human_required':
      return { ...base, status: TRACKER_STATUS.ACTION_REQUIRED, action_required: 'YES', action_reason: result.note || 'Human action is required to continue this ATS application.' };
    case 'error':
      return { ...base, status: TRACKER_STATUS.ATS_QUEUED, action_reason: result.note || 'ATS attempt failed and remains queued.' };
    default:
      return { ...base, status: TRACKER_STATUS.ATS_QUEUED, action_reason: result.note || 'ATS result needs another safe pass.' };
  }
}

async function recordAtsLocalState(jobId, result) {
  const note = String(result.note || '').slice(0, 1000);
  if (result.state === 'applied') {
    const now = Date.now();
    await run(
      `UPDATE jobs SET status = 'applied', auto_apply_state = 'applied', auto_apply_note = ?,
        auto_applied_at = ?, applied_at = COALESCE(applied_at, ?), status_changed_at = ? WHERE id = ?`,
      [note, now, now, now, jobId]
    );
    return;
  }
  const state = result.state === 'human_required' ? 'needs_input' : result.state;
  await run('UPDATE jobs SET auto_apply_state = ?, auto_apply_note = ? WHERE id = ?', [state, note, jobId]);
}

async function queueInterventions(profileId, jobId, result) {
  const created = [];
  for (const q of result.missing || []) {
    const item = await createIntervention(profileId, {
      jobId, kind: 'question', questionKey: q.field_key || null,
      prompt: q.label || q.field_key || 'Application question requires an answer.', options: q.options || null,
    });
    created.push(item.id);
  }
  if (result.state === 'submit_clicked') {
    const item = await createIntervention(profileId, { jobId, kind: 'reconcile_submission', prompt: result.note || 'Confirm whether this application was submitted.' });
    created.push(item.id);
  } else if (result.state === 'human_required') {
    const item = await createIntervention(profileId, { jobId, kind: result.kind || 'human_required', prompt: result.note || 'Human action is required.' });
    created.push(item.id);
  } else if ((result.state === 'needs_input' || result.state === 'applied_incomplete') && !(result.missing || []).length) {
    const item = await createIntervention(profileId, { jobId, kind: 'human_required', prompt: result.note || 'Human input is required.' });
    created.push(item.id);
  }
  return created;
}

export async function orchestratorStatus(profileId) {
  const ready = await trackerReady();
  return {
    tracker: ready,
    stats: ready.configured ? await trackerStats(profileId) : {},
    recentRuns: await recentOrchestratorRuns(profileId, 10),
  };
}

export async function runOrchestrator(profileId, { armed = false, limit = 10 } = {}) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new Error('profile not found');
  const ready = await trackerReady();
  if (!ready.configured) throw new Error('Google Sheets tracker is not configured.');

  const owner = `orchestrator:${process.pid}:${Date.now()}`;
  const leaseKey = `orchestrator:${profileId}`;
  if (!await acquireLease(leaseKey, owner, 15 * 60 * 1000)) throw new Error('Another orchestrator run is already active for this profile.');
  const heartbeat = setInterval(() => renewLease(leaseKey, owner, 15 * 60 * 1000).catch(() => {}), 60 * 1000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  let runId = null;
  try {
    const trackerRows = await readTrackerRows();
    await recoverStaleRunningRows(trackerRows);
    const freshRows = await readTrackerRows();
    const synced = await syncTrackerRows(profileId, freshRows);
    const selected = selectLifoRows(synced, limit, { armed });

    runId = await beginOrchestratorRun(profileId, {
      armed, selected: selected.map((r) => ({ record_id: r.record_id, job_id: r.job_id, sheet_row: r.sheet_row, status: r.status })),
    });
    if (!selected.length) {
      const empty = { armed, selected: 0, applied: 0, actionRequired: 0, failed: 0, atsReady: 0, results: [] };
      await finishOrchestratorRun(runId, empty);
      return empty;
    }

    const summary = { armed, selected: selected.length, applied: 0, actionRequired: 0, failed: 0, atsReady: 0, boardAttempted: 0, atsChecked: 0, atsLive: 0, results: [] };

    // Strict cross-channel LIFO: process each selected Sheet row in order. This is
    // intentionally serial. The Sheet must never say A was ahead of B while a parallel
    // board worker submits B first.
    for (const row of selected) {
      const job = await get('SELECT * FROM jobs WHERE id = ? AND profile_id = ?', [row.job_id, profileId]);
      if (!job) {
        await updateTrackerRow(row, { status: TRACKER_STATUS.FAILED, action_required: 'YES', action_reason: 'Local job record is missing.' });
        summary.failed++;
        continue;
      }

      await updateTrackerRow(row, { status: TRACKER_STATUS.RUNNING, last_attempt_at: nowIso(), action_required: '', action_reason: '' });
      const ats = isAtsRow(row, job);
      let result;

      if (ats) {
        // Two-stage safety: ATS_QUEUED/NOT_APPLIED always gets a dry proof first.
        // A live click is allowed only when the same Sheet row already reached ATS_READY.
        const liveAts = armed && row.status === TRACKER_STATUS.ATS_READY;
        const engine = await runAtsBatch(profile, [job], { armed: liveAts });
        result = engine.results?.[0] || { state: 'error', note: 'ATS engine produced no final result.' };
        summary.atsChecked++;
        if (liveAts) summary.atsLive++;
        await recordAtsLocalState(job.id, result);
        const patch = atsPatch(row, result);
        await updateTrackerRow(row, patch);
        if (patch.status === TRACKER_STATUS.ATS_READY) summary.atsReady++;
        if (patch.status === TRACKER_STATUS.APPLIED) summary.applied++;
        if (patch.status === TRACKER_STATUS.ACTION_REQUIRED) {
          summary.actionRequired++;
          await queueInterventions(profileId, job.id, result);
        }
      } else {
        const engine = await guardedAutoApplyRun(profile, { armed, limit: 1, jobIds: [job.id] });
        result = engine.results?.find((x) => x.job_id === job.id) || { state: 'error', note: 'Board engine produced no final result.' };
        summary.boardAttempted++;
        const patch = boardPatch(row, result, armed);
        await updateTrackerRow(row, patch);
        if (patch.status === TRACKER_STATUS.APPLIED) summary.applied++;
        if (patch.status === TRACKER_STATUS.FAILED) summary.failed++;
        if (patch.status === TRACKER_STATUS.ACTION_REQUIRED) {
          summary.actionRequired++;
          await queueInterventions(profileId, job.id, result);
        }
      }

      summary.results.push({ record_id: row.record_id, job_id: job.id, company: job.company, title: job.title, channel: ats ? 'ATS' : job.connector, ...result });
    }

    await finishOrchestratorRun(runId, summary);
    return summary;
  } catch (e) {
    if (runId) await failOrchestratorRun(runId, e).catch(() => {});
    throw e;
  } finally {
    clearInterval(heartbeat);
    await releaseLease(leaseKey, owner).catch(() => {});
  }
}
