import { get, run, all } from './db.js';
import { parseFilters } from './profileSettings.js';
import { runOrchestrator } from './orchestrator.js';
import { sentToday, stop as stopLegacySchedule } from './scheduler.js';
import { lcmd, linfo, lwarn, lerr } from './logger.js';

const timers = new Map();
const running = new Set();

const MIN_MINUTES = 15;
const MAX_MINUTES = 24 * 60;
const DEFAULT_DAILY_CAP = 30;

export function defaultOrchestratorSchedule() {
  return {
    enabled: false,
    armed: false,
    everyMinutes: 60,
    limit: 10,
    dailyCap: DEFAULT_DAILY_CAP,
  };
}

export function readOrchestratorSchedule(profile) {
  const s = parseFilters(profile).orchestrator_schedule;
  return {
    ...defaultOrchestratorSchedule(),
    ...(s && typeof s === 'object' ? s : {}),
  };
}

function clamp(cfg) {
  return {
    enabled: cfg.enabled === true,
    armed: cfg.armed === true,
    everyMinutes: Math.max(MIN_MINUTES, Math.min(Number(cfg.everyMinutes) || 60, MAX_MINUTES)),
    limit: Math.max(1, Math.min(Number(cfg.limit) || 10, 25)),
    dailyCap: Math.max(1, Math.min(Number(cfg.dailyCap) || DEFAULT_DAILY_CAP, 200)),
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
  };
}

export async function setOrchestratorSchedule(profileId, patch) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new Error('profile not found');

  const filters = parseFilters(profile);
  const cfg = clamp({ ...readOrchestratorSchedule(profile), ...patch });

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
      ? `📋 Sheet orchestrator scheduled: LIVE every ${cfg.everyMinutes} min, up to ${cfg.limit}/run, cap ${cfg.dailyCap}/day`
      : `📋 Sheet orchestrator scheduled: DRY RUN every ${cfg.everyMinutes} min, up to ${cfg.limit}/run`);
  } else {
    lcmd(profileId, '📋 Sheet orchestrator schedule stopped.');
  }
  return cfg;
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
  if (cfg.armed) {
    const sent = await sentToday(profileId);
    if (sent >= cfg.dailyCap) {
      lwarn(profileId, `📋 Daily confirmed-application cap reached (${sent}/${cfg.dailyCap}).`);
      return;
    }
    limit = Math.min(limit, cfg.dailyCap - sent);
  }

  running.add(profileId);
  try {
    lcmd(profileId, `📋 Scheduled Sheet orchestrator: ${cfg.armed ? 'LIVE' : 'dry run'}, limit ${limit}`);
    const summary = await runOrchestrator(profileId, { armed: cfg.armed, limit });
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
        + `limit ${cfg.limit}, daily cap ${cfg.dailyCap}`
      );
    }
  } catch (e) {
    console.warn('[JobFinder] could not resume Sheet orchestrator schedules:', e?.message || e);
  }
  return started;
}
