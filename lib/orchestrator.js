import { get, run } from './db.js';
import { parseFilters } from './profileSettings.js';
import { applicationChannel, processOrderedApplications, selectCanaryRows, retryAttempts, PREPARATION_VERSION } from './orderedApplications.js';
import { sentToday } from './scheduler.js';
import { publishAutomationHealth } from './automationHealth.js';
import { HttpError } from './http.js';
import { guardedAutoApplyRun } from './guardedAutoApply.js';
import { applyAtsJob } from './atsApply.js';
import { trackerApplicationRoute } from './trackerApplicationRoute.js';
import { syncRemoteInterventions } from './remoteInterventions.js';
import { acquireLease, renewLease, releaseLease } from './runtimeLease.js';
import {
  TRACKER_STATUS,
  readTrackerRows,
  selectLifoRows,
  syncTrackerRows,
  updateTrackerRow,
  recoverStaleRunningRows,
  exportUnmirroredJobsToTracker,
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
        status: TRACKER_STATUS.NOT_APPLIED,
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

export async function runOrchestrator(profileId, { armed = false, limit = 10, excludedChannels = [] } = {}) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new Error('profile not found');
  const schedule = parseFilters(profile).orchestrator_schedule || {};
  const proofAge = Date.now() - Number(schedule.qualifiedAt || 0);
  const validProof = schedule.preparationVersion === PREPARATION_VERSION && proofAge >= 0 && proofAge < 24 * 3600000;
  const liveChannels = validProof && Array.isArray(schedule.liveChannels) ? schedule.liveChannels : [];
  if (armed && (!schedule.armed || !liveChannels.length)) throw new HttpError(409, 'LIVE needs a current passing application check. Activate AUTOPILOT to run it automatically.');

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
    // First bridge anything already discovered locally into the business source of truth.
    const exportedBefore = await exportUnmirroredJobsToTracker(profileId);

    // Pull answers entered remotely before choosing the next batch. This can turn
    // ACTION_REQUIRED rows back into NOT_APPLIED when their only blocker was a question.
    const interventionsBefore = await syncRemoteInterventions(profileId);
    const trackerRows = await readTrackerRows();
    await recoverStaleRunningRows(trackerRows);
    const freshRows = await readTrackerRows();
    const synced = await syncTrackerRows(profileId, freshRows);
    const qualifying = !armed && schedule.autopilotConsent === true;
    if (armed) limit = Math.max(0, Math.min(limit, Number(schedule.limit || 10), Number(schedule.dailyCap || 30) - await sentToday(profileId)));
    const candidates = limit > 0 ? selectLifoRows(synced, qualifying ? 5000 : limit, {
      armed, profile, recheckPrepared: !armed && schedule.autopilotConsent === true,
      acceptRow: (row) => !excludedChannels.includes(applicationChannel(row))
        && (!armed || liveChannels.includes(applicationChannel(row))),
    }) : [];
    const selected = qualifying ? selectCanaryRows(candidates, limit) : candidates;

    runId = await beginOrchestratorRun(profileId, {
      armed,
      selected: selected.map((r) => ({ record_id: r.record_id, job_id: r.job_id, sheet_row: r.sheet_row })),
    });

    if (!selected.length) {
      const summary = {
        armed,
        preparationVersion: PREPARATION_VERSION,
        channels: [],
        selected: 0,
        applied: 0,
        actionRequired: 0,
        failed: 0,
        unsupported: 0,
        interventions: { before: interventionsBefore },
        exported: exportedBefore.exported || 0,
      };
      await finishOrchestratorRun(runId, summary);
      return summary;
    }

    const boardAutomatable = selected.filter((r) => trackerApplicationRoute(r) === 'board');
    const atsAutomatable = selected.filter((r) => trackerApplicationRoute(r) === 'ats');
    const engine = { results: [], deferredDetails: [], applied: 0, unconfirmed: 0,
      dryRun: 0, needsInput: 0, errors: 0, deferred: 0, skipped: 0,
      loginRequired: [], rateLimited: [], uiUnavailable: [], parked: [] };
    const ats = { applied: 0, dryRun: 0, unconfirmed: 0, needsInput: 0, errors: 0 };
    let actionRequired = 0;
    let failed = 0;
    const ordered = await processOrderedApplications(selected, {
      onStart: (row) => updateTrackerRow(row, {
        status: TRACKER_STATUS.RUNNING, last_attempt_at: nowIso(), action_required: '', action_reason: '',
      }),
      execute: async (row) => {
        if (trackerApplicationRoute(row) === 'board') {
          let one;
          try { one = await guardedAutoApplyRun(profile, { armed, limit: 1, jobIds: [row.job_id] }); }
          catch (e) { return { state: 'ui_unavailable', note: 'Application browser unavailable: ' + String(e.message || e).slice(0, 200) }; }
          for (const key of ['applied','unconfirmed','dryRun','needsInput','errors','deferred','skipped']) engine[key] += Number(one[key] || 0);
          for (const key of ['results','deferredDetails','parked']) engine[key].push(...(one[key] || []));
          for (const key of ['loginRequired','rateLimited','uiUnavailable']) engine[key] = [...new Set([...engine[key], ...(one[key] || [])])];
          return (one.results || []).find((r) => r.job_id === row.job_id)
            || (one.deferredDetails || []).find((r) => r.job_id === row.job_id)
            || { state: 'not_attempted', note: 'Job is waiting for an answer or no longer eligible in the local application engine.' };
        }
        const job = await get('SELECT * FROM jobs WHERE id = ? AND profile_id = ?', [row.job_id, profileId]);
        if (!job) return { state: 'not_attempted', note: 'Job is not present in this profile.' };
        const result = await applyAtsJob(profile, job, { armed }).catch((e) => ({ state: 'ui_unavailable', note: 'Application browser unavailable: ' + String(e.message || e).slice(0, 200) }));
        await run(
          `UPDATE jobs SET auto_apply_state = ?, auto_apply_note = ?, auto_applied_at = ?,
           auto_apply_attempts = ?, auto_apply_blocked_on = ?,
           status = CASE WHEN ? = 'applied' THEN 'applied' ELSE status END,
           applied_at = CASE WHEN ? = 'applied' THEN COALESCE(applied_at, ?) ELSE applied_at END,
           status_changed_at = CASE WHEN ? = 'applied' THEN ? ELSE status_changed_at END WHERE id = ?`,
          [result.state, result.note || '', result.state === 'applied' ? Date.now() : null,
           retryAttempts(job.auto_apply_attempts, result.state),
           result.parked?.length ? JSON.stringify(result.parked) : null,
           result.state, result.state, Date.now(), result.state, Date.now(), row.job_id]
        );
        const key = { applied: 'applied', dry_run: 'dryRun', submit_clicked: 'unconfirmed', needs_input: 'needsInput', error: 'errors' }[result.state];
        if (key) ats[key]++;
        return result;
      },
      onResult: async (row, result) => {
        const transient = ['ui_unavailable','auth_required','rate_limited','unclear','not_attempted'].includes(result.state);
        if (transient) {
          await updateTrackerRow(row, {
            status: row.status === TRACKER_STATUS.DRY_RUN_OK ? TRACKER_STATUS.DRY_RUN_OK : TRACKER_STATUS.NOT_APPLIED,
            last_attempt_at: nowIso(), action_reason: 'Deferred (' + result.state + '): ' + String(result.note || '').slice(0, 300),
          });
        } else {
          const patch = resultPatch(row, result, armed);
          if (patch.status === TRACKER_STATUS.ACTION_REQUIRED) actionRequired++;
          if (patch.status === TRACKER_STATUS.FAILED) failed++;
          await updateTrackerRow(row, patch);
        }
      },
    });
    // A one-job serial call stops the route immediately, rather than needing
    // three parallel modal failures to report a systemic UI problem.
    for (const health of ordered.channels) {
      for (const [state, key] of [['ui_unavailable','uiUnavailable'],['auth_required','loginRequired'],['rate_limited','rateLimited']]) {
        if (health.blocked.includes(state) && !engine[key].includes(health.channel)) engine[key].push(health.channel);
      }
    }

    // Export any questions parked during this run so they appear in the remote
    // Interventions tab immediately for the next office-side review.
    const interventionsAfter = await syncRemoteInterventions(profileId);

    const summary = {
      armed,
      selected: selected.length,
      preparationVersion: PREPARATION_VERSION,
      channels: ordered.channels,
      outcomes: ordered.results,
      automatable: selected.length,
      boardAutomatable: boardAutomatable.length,
      atsAutomatable: atsAutomatable.length,
      unsupported: 0,
      applied: engine.applied + ats.applied,
      unconfirmed: engine.unconfirmed + ats.unconfirmed,
      actionRequired, failed, ats, engine,
      interventions: {
        before: interventionsBefore,
        after: interventionsAfter,
      },
      exported: exportedBefore.exported || 0,
    };
    await finishOrchestratorRun(runId, summary);
    await publishAutomationHealth(profileId, summary).catch((e) => console.warn('[JobFinder] Health sheet sync:', e.message));
    return summary;
  } catch (e) {
    if (runId) await failOrchestratorRun(runId, e).catch(() => {});
    throw e;
  } finally {
    clearInterval(heartbeat);
    await releaseLease(leaseKey, owner).catch(() => {});
  }
}
