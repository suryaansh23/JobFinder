import { get } from './db.js';
import { guardedAutoApplyRun } from './guardedAutoApply.js';
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

function nowIso() {
  return new Date().toISOString();
}

function resultPatch(row, result, armed) {
  const attempts = (Number(row.attempts) || 0) + 1;
  const base = {
    last_attempt_at: nowIso(),
    attempts,
    confirmation: result.note || '',
    action_required: '',
    action_reason: '',
  };

  switch (result.state) {
    case 'applied':
      return {
        ...base,
        status: TRACKER_STATUS.APPLIED,
        applied_at: nowIso(),
        confirmation: result.note || 'Application confirmed',
      };
    case 'already_applied':
      return {
        ...base,
        status: TRACKER_STATUS.APPLIED,
        applied_at: row.applied_at || nowIso(),
        confirmation: result.note || 'Board reports already applied',
      };
    case 'submit_clicked':
      return {
        ...base,
        status: TRACKER_STATUS.ACTION_REQUIRED,
        action_required: 'YES',
        action_reason: 'Submission was clicked but confirmation was not observed. Reconcile manually before retrying.',
      };
    case 'needs_input':
    case 'applied_incomplete':
      return {
        ...base,
        status: TRACKER_STATUS.ACTION_REQUIRED,
        action_required: 'YES',
        action_reason: result.note || 'Application needs user input.',
      };
    case 'abandoned':
      return {
        ...base,
        status: TRACKER_STATUS.FAILED,
        action_required: 'YES',
        action_reason: result.note || 'Retry limit reached.',
      };
    case 'expired':
      return {
        ...base,
        status: TRACKER_STATUS.SKIPPED,
        action_reason: result.note || 'Listing expired.',
      };
    case 'external':
    case 'unsupported':
      return {
        ...base,
        status: TRACKER_STATUS.ATS_QUEUED,
        apply_channel: 'ATS',
        action_reason: result.note || 'Queued for the external ATS engine.',
      };
    case 'dry_run':
      return {
        ...base,
        status: TRACKER_STATUS.DRY_RUN_OK,
        confirmation: result.note || 'Dry run completed.',
      };
    case 'error':
      return {
        ...base,
        status: TRACKER_STATUS.NOT_APPLIED,
        action_reason: result.note || 'Attempt failed; remains queued for retry.',
      };
    default:
      return {
        ...base,
        status: armed ? TRACKER_STATUS.NOT_APPLIED : TRACKER_STATUS.DRY_RUN_OK,
        confirmation: result.note || '',
      };
  }
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
  if (!ready.configured) {
    throw new Error('Google Sheets tracker is not configured.');
  }

  const owner = `orchestrator:${process.pid}:${Date.now()}`;
  const leaseKey = `orchestrator:${profileId}`;
  if (!await acquireLease(leaseKey, owner, 15 * 60 * 1000)) {
    throw new Error('Another orchestrator run is already active for this profile.');
  }

  const heartbeat = setInterval(() => {
    renewLease(leaseKey, owner, 15 * 60 * 1000).catch(() => {});
  }, 60 * 1000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  let runId = null;
  try {
    const trackerRows = await readTrackerRows();
    await recoverStaleRunningRows(trackerRows);
    const freshRows = await readTrackerRows();
    const synced = await syncTrackerRows(profileId, freshRows);
    const selected = selectLifoRows(synced, limit, { armed });

    runId = await beginOrchestratorRun(profileId, {
      armed,
      selected: selected.map((r) => ({ record_id: r.record_id, job_id: r.job_id, sheet_row: r.sheet_row })),
    });

    if (!selected.length) {
      const summary = { armed, selected: 0, applied: 0, actionRequired: 0, failed: 0, unsupported: 0 };
      await finishOrchestratorRun(runId, summary);
      return summary;
    }

    const automatable = selected.filter((r) =>
      ['linkedin', 'naukri'].includes(r.connector) && r.apply_kind !== 'external'
    );
    const unsupported = selected.filter((r) => !automatable.includes(r));

    for (const row of automatable) {
      await updateTrackerRow(row, {
        status: TRACKER_STATUS.RUNNING,
        last_attempt_at: nowIso(),
        action_required: '',
        action_reason: '',
      });
    }

    const engine = automatable.length
      ? await guardedAutoApplyRun(profile, {
          armed,
          limit: automatable.length,
          jobIds: automatable.map((r) => r.job_id),
        })
      : { results: [], applied: 0, unconfirmed: 0, needsInput: 0, errors: 0 };

    const byJob = new Map((engine.results || []).map((r) => [r.job_id, r]));
    let actionRequired = 0;
    let failed = 0;

    for (const row of automatable) {
      const result = byJob.get(row.job_id);
      if (!result) {
        await updateTrackerRow(row, {
          status: row.status === TRACKER_STATUS.DRY_RUN_OK ? TRACKER_STATUS.DRY_RUN_OK : TRACKER_STATUS.NOT_APPLIED,
          last_attempt_at: nowIso(),
          action_reason: 'No final engine result was recorded. Job remains eligible for a later retry.',
        });
        continue;
      }
      const patch = resultPatch(row, result, armed);
      if (patch.status === TRACKER_STATUS.ACTION_REQUIRED) actionRequired++;
      if (patch.status === TRACKER_STATUS.FAILED) failed++;
      await updateTrackerRow(row, patch);
    }

    for (const row of unsupported) {
      await updateTrackerRow(row, {
        status: TRACKER_STATUS.ATS_QUEUED,
        apply_channel: row.apply_channel || 'ATS',
        action_required: '',
        action_reason: row.action_reason || 'Queued for the external ATS engine. Not submitted by Phase 2.',
      });
    }

    const summary = {
      armed,
      selected: selected.length,
      automatable: automatable.length,
      unsupported: unsupported.length,
      applied: engine.applied || 0,
      unconfirmed: engine.unconfirmed || 0,
      actionRequired,
      failed,
      engine,
    };
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
