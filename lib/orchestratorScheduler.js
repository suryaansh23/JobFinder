import { get, run, all } from './db.js';
import { parseFilters } from './profileSettings.js';
import { runOrchestrator } from './orchestrator.js';
import { scanConnectors } from './scanRunner.js';
import { exportUnmirroredJobsToTracker } from './masterTracker.js';
import { sentToday, stop as stopLegacySchedule } from './scheduler.js';
import { lcmd, linfo, lwarn, lerr } from './logger.js';
import { assessCanary, assessLiveHealth } from './autopilotPolicy.js';
import { recentOrchestratorRuns } from './orchestratorStore.js';

const timers = new Map();
const running = new Set();

const MIN_MINUTES = 15;
const MAX_MINUTES = 24 * 60;
const DEFAULT_DAILY_CAP = 30;

export function defaultOrchestratorSchedule() {
  return {
    enabled: false,
    armed: false,
    // Single user authorization for LIVE once repeated SAFE probes show a
    // working form. Remains pending across reboots. Never bypasses canary.
    promoteWhenReady: false,
    autopilotConsent: false,
    // Unlimited means no arbitrary total-application quota. Runtime remains
    // bounded and each site gets paced, retryable, deduplicated attempts.
    unlimited: false,
    everyMinutes: 60,
    limit: 10,
    dailyCap: DEFAULT_DAILY_CAP,
    scan: true,
    scanEveryMinutes: 60,
    lastScanAt: 0,
  };
}

export function readOrchestratorSchedule(profile) {
  const s = parseFilters(profile).orchestrator_schedule;
  return {
    ...defaultOrchestratorSchedule(),
    ...(s && typeof s === 'object' ? s : {}),
    // Existing users who already granted AUTOPILOT authorization should not
    // have to re-authorize or manually change a setting after this update.
    unlimited: s?.unlimited === true || (s?.autopilotConsent === true && s?.unlimited !== false),
  };
}

function clamp(cfg) {
  return {
    enabled: cfg.enabled === true,
    armed: cfg.armed === true,
    promoteWhenReady: cfg.promoteWhenReady === true,
    autopilotConsent: cfg.autopilotConsent === true,
    unlimited: cfg.unlimited === true,
    everyMinutes: Math.max(MIN_MINUTES, Math.min(Number(cfg.everyMinutes) || 60, MAX_MINUTES)),
    limit: Math.max(1, Math.min(Number(cfg.limit) || 10, 25)),
    dailyCap: Math.max(1, Math.min(Number(cfg.dailyCap) || DEFAULT_DAILY_CAP, 200)),
    scan: cfg.scan !== false,
    scanEveryMinutes: Math.max(30, Math.min(Number(cfg.scanEveryMinutes) || 60, MAX_MINUTES)),
    lastScanAt: Number(cfg.lastScanAt) || 0,
  };
}

export function stopOrchestratorSchedule(profileId) {
  const t = timers.get(profileId);
  if (t) clearTimeout(t);
  timers.delete(profileId);
}

function arm(profileId, cfg, delayMs) {
  const t = setTimeout(() => tick(profileId), delayMs);
  if (typeof t.unref === 'function') t.unref();
  t.__nextRunAt = Date.now() + delayMs;
  timers.set(profileId, t);
}

export async function orchestratorScheduleStatus(profileId) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) return null;
  const cfg = readOrchestratorSchedule(profile);
  const t = timers.get(profileId);
  return {
    ...cfg,
    running: running.has(profileId),
    nextRunAt: t?.__nextRunAt || null,
    sentToday: await sentToday(profileId),
    // Status message for dashboard/operator; never a proof of completed apply.
    mode: cfg.armed ? 'LIVE' : cfg.promoteWhenReady ? 'AUTO-QUALIFYING' : cfg.enabled ? 'SAFE' : 'PAUSED',
  };
}

async function stampOrchestratorScan(profileId) {
  try {
    const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
    if (!profile) return;
    const filters = parseFilters(profile);
    filters.orchestrator_schedule = {
      ...readOrchestratorSchedule(profile),
      lastScanAt: Date.now(),
    };
    await run('UPDATE profiles SET filters = ? WHERE id = ?', [JSON.stringify(filters), profileId]);
  } catch {
    // Missing a stamp only causes an earlier future scan; never fail the run for this.
  }
}

export async function setOrchestratorSchedule(profileId, patch) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new Error('profile not found');

  const filters = parseFilters(profile);
  const cfg = clamp({ ...readOrchestratorSchedule(profile), ...patch });

  // No route can bypass the LIVE safety gate with armed:true, even if a
  // direct API client or the old controller tries to arm it.
  const wasArmed = readOrchestratorSchedule(profile).armed;
  if (cfg.armed && !wasArmed) {
    const recent = await recentOrchestratorRuns(profileId, 10);
    const lastSafe = recent.find((r) => r.mode === 'dry_run');
    let summary = {};
    try { summary = JSON.parse(lastSafe?.summary_json || '{}'); } catch {}
    const gate = assessCanary(summary);
    const age = Date.now() - Number(lastSafe?.finished_at || 0);
    if (lastSafe?.state !== 'done' || age < 0 || age > 24 * 3600000 || !gate.ready) {
      throw new Error('LIVE blocked: no recent passing SAFE application canary. Activate AUTOPILOT to self-test automatically.');
    }
  }

  // Promotion consent is meaningful only with scheduling enabled. Pausing
  // explicitly revokes unattended promotion.
  if (!cfg.enabled) {
    cfg.promoteWhenReady = false;
    cfg.autopilotConsent = false;
  }
  if (cfg.armed) cfg.promoteWhenReady = false;
  filters.orchestrator_schedule = cfg;

  // The Sheet-driven orchestrator and the legacy board-driven scheduler must never
  // both be armed. Enabling this scheduler disables the old one in persisted state.
  if (cfg.enabled) {
    const legacy = filters.auto_apply_schedule;
    if (legacy && typeof legacy === 'object') {
      filters.auto_apply_schedule = { ...legacy, enabled: false, armed: false };
    }
    stopLegacySchedule(profileId);
  }

  await run('UPDATE profiles SET filters = ? WHERE id = ?', [JSON.stringify(filters), profileId]);

  stopOrchestratorSchedule(profileId);
  if (cfg.enabled) {
    arm(profileId, cfg, cfg.everyMinutes * 60000);
    lcmd(profileId, cfg.armed
      ? (cfg.unlimited
        ? `📋 Sheet AUTOPILOT: LIVE every ${cfg.everyMinutes} min, no fixed application quota; paced and site limits respected`
        : `📋 Sheet orchestrator scheduled: LIVE every ${cfg.everyMinutes} min, up to ${cfg.limit}/run, cap ${cfg.dailyCap}/day`)
      : `📋 Sheet orchestrator scheduled: SAFE every ${cfg.everyMinutes} min; forms tested, never submitted`);
  } else {
    lcmd(profileId, '📋 Sheet orchestrator schedule stopped.');
  }
  return cfg;
}


export async function evaluateAndAdvanceAutopilot(profileId, summary) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  const cfg = profile ? readOrchestratorSchedule(profile) : defaultOrchestratorSchedule();
  const gate = assessCanary(summary);
  if (!cfg.enabled || cfg.armed || !cfg.promoteWhenReady || !cfg.autopilotConsent) {
    return { promoted: false, gate, reason: 'No pending AUTOPILOT authorization' };
  }
  if (!gate.ready) return { promoted: false, gate };
  // Server-side evidence was already persisted by runOrchestrator and will
  // be checked a second time by setOrchestratorSchedule.
  await setOrchestratorSchedule(profileId, { enabled: true, armed: true, promoteWhenReady: false });
  return { promoted: true, gate };
}


/**
 * Work through the queue in small durable transactions. The ten-row chunk is
 * not an application quota: it bounds each database/Sheet write and gives the
 * scheduler a chance to detect failed sites. Continue until no unattempted
 * supported jobs remain or the time budget is reached; remaining jobs are
 * picked up automatically next tick. A job cannot be retried twice in one tick.
 */
export async function drainUncappedQueue(profileId, cfg, {
  runBatch = runOrchestrator,
  now = Date.now,
  budgetMs = 10 * 60 * 1000,
  chunkSize = 10,
} = {}) {
  const excluded = new Set();
  const total = {
    armed: true, selected: 0, applied: 0, unconfirmed: 0,
    actionRequired: 0, failed: 0, unsupported: 0,
    engine: { errors: 0, loginRequired: [], rateLimited: [], uiUnavailable: [] },
    ats: { errors: 0 },
    batches: 0, exhaustReason: '',
  };
  const start = now();
  while (now() - start < budgetMs) {
    // Honour pause requests even while a long queue is draining.
    const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
    if (!profile) { total.exhaustReason = 'profile missing'; break; }
    const latest = readOrchestratorSchedule(profile);
    if (!latest.enabled || !latest.armed) { total.exhaustReason = 'LIVE paused'; break; }
    const batch = await runBatch(profileId, {
      armed: true, limit: chunkSize, excludeJobIds: [...excluded],
    });
    const picked = (batch.selectedJobs || []).map((j) => j.job_id).filter(Boolean);
    if (!picked.length || !Number(batch.selected || 0)) {
      total.exhaustReason = 'no more eligible jobs';
      break;
    }
    for (const id of picked) excluded.add(id);
    total.batches++;
    for (const k of ['selected','applied','unconfirmed','actionRequired','failed','unsupported']) {
      total[k] += Number(batch[k] || 0);
    }
    total.engine.errors += Number(batch.engine?.errors || 0);
    total.ats.errors += Number(batch.ats?.errors || 0);
    for (const field of ['loginRequired','rateLimited','uiUnavailable']) {
      for (const source of batch.engine?.[field] || []) {
        if (!total.engine[field].includes(source)) total.engine[field].push(source);
      }
    }
    const health = assessLiveHealth(total);
    if (health.quarantine) {
      total.exhaustReason = health.reason;
      break;
    }
  }
  if (!total.exhaustReason) total.exhaustReason = 'time-sliced: remaining jobs resume next tick';
  return total;
}

async function tick(profileId) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]).catch(() => null);
  if (!profile) return stopOrchestratorSchedule(profileId);

  const cfg = readOrchestratorSchedule(profile);
  if (!cfg.enabled) return stopOrchestratorSchedule(profileId);

  // Re-arm first so one thrown run cannot silently kill the 24/7 schedule.
  arm(profileId, cfg, cfg.everyMinutes * 60000);

  if (running.has(profileId)) {
    lwarn(profileId, '📋 Orchestrator slot skipped: previous run is still active.');
    return;
  }

  let limit = cfg.limit;
  if (cfg.armed && !cfg.unlimited) {
    const sent = await sentToday(profileId);
    if (sent >= cfg.dailyCap) {
      lwarn(profileId, `📋 Daily confirmed-application cap reached (${sent}/${cfg.dailyCap}).`);
      return;
    }
    limit = Math.min(limit, cfg.dailyCap - sent);
  }

  running.add(profileId);
  try {
    if (cfg.scan && Date.now() - (cfg.lastScanAt || 0) >= cfg.scanEveryMinutes * 60000) {
      lcmd(profileId, '📡 Scheduled discovery scan before Sheet orchestration');
      try {
        const scan = await scanConnectors(profile);
        const found = scan.results.reduce((n, r) => n + (r.found || 0), 0);
        const exported = await exportUnmirroredJobsToTracker(profileId);
        linfo(profileId, `📡 Discovery scan found ${found} new job(s); ${exported.exported || 0} added to the Sheet queue.`);
      } catch (e) {
        lwarn(profileId, `📡 Discovery scan/export failed: ${String(e?.message || e).slice(0, 160)}. Continuing with the existing Sheet queue.`);
      }
      await stampOrchestratorScan(profileId);
    } else {
      // A manual scan may have run since the last scheduler slot; export those rows too.
      try { await exportUnmirroredJobsToTracker(profileId); } catch {}
    }

    lcmd(profileId, `📋 Scheduled Sheet orchestrator: ${cfg.armed ? 'LIVE' : 'SAFE'}, ${cfg.unlimited ? 'no quota' : 'limit ' + limit}`);
    const summary = cfg.armed && cfg.unlimited
      ? await drainUncappedQueue(profileId, cfg)
      : await runOrchestrator(profileId, { armed: cfg.armed, limit });
    if (!cfg.armed && cfg.promoteWhenReady && cfg.autopilotConsent) {
      const promotion = await evaluateAndAdvanceAutopilot(profileId, summary);
      linfo(profileId, promotion.promoted
        ? 'AUTOPILOT: SAFE gate passed. LIVE applications armed without a fixed daily quota.'
        : 'AUTOPILOT pending: ' + promotion.gate.reason + '. SAFE self-tests continue hourly.');
    } else if (cfg.armed) {
      const health = assessLiveHealth(summary);
      if (health.quarantine) {
        // Keep discovery going. Only submission permission is suspended,
        // and the prior one-time AUTOPILOT authorization triggers periodic
        // SAFE probes until the engine recovers.
        await setOrchestratorSchedule(profileId, {
          enabled: true, armed: false,
          promoteWhenReady: cfg.autopilotConsent === true,
        });
        lwarn(profileId, 'LIVE automatically suspended: ' + health.reason + ' (' + health.blockers.join(', ') + ').');
      }
    }
    linfo(
      profileId,
      `📋 Orchestrator done: selected ${summary.selected || 0} · confirmed ${summary.applied || 0} · `
      + `unconfirmed ${summary.unconfirmed || 0} · action ${summary.actionRequired || 0} · ATS ${summary.unsupported || 0}`
    );
  } catch (e) {
    lerr(profileId, `📋 Scheduled orchestrator failed: ${String(e?.message || e).slice(0, 220)}`);
  } finally {
    running.delete(profileId);
  }
}

export async function startAllOrchestrators() {
  let started = 0;
  try {
    for (const profile of await all('SELECT * FROM profiles')) {
      const cfg = readOrchestratorSchedule(profile);
      if (!cfg.enabled) continue;
      // Delay after boot to avoid a burst during updates/restarts.
      arm(profile.id, cfg, Math.min(cfg.everyMinutes, 5) * 60000);
      started++;
      console.log(
        `[JobFinder] 📋 Sheet orchestrator resumed for "${profile.name}": `
        + `${cfg.armed ? 'LIVE' : 'dry run'}, every ${cfg.everyMinutes} min, `
        + (cfg.unlimited ? 'unlimited eligible applications, paced by site' : `limit ${cfg.limit}, daily cap ${cfg.dailyCap}`)
      );
    }
  } catch (e) {
    console.warn('[JobFinder] could not resume Sheet orchestrator schedules:', e?.message || e);
  }
  return started;
}
