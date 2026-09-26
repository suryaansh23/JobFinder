// Scheduled auto-apply: run a batch every N minutes without you being there.
//
// This is the one thing in JobFinder that acts on its own, and when it is armed it
// sends real applications to real employers while nobody is watching. Everything below
// is shaped by that.
//
// FOUR BRAKES, because "it ran all night" is the failure that matters
//   1. A daily cap, counted from applications actually sent today — not from a counter
//      this process keeps. A restart, a second window, a crash mid-run: none of them
//      can reset it, because the number is derived from the jobs table.
//   2. One run at a time per profile. A batch that overruns its interval must not have
//      a second one started on top of it, both driving the same browser.
//   3. A timeout chain rather than setInterval, so a slow run delays the next one
//      instead of stacking.
//   4. Arming is explicit and visible, and the schedule announces itself loudly in the
//      log on every server start — a background sender that starts quietly is exactly
//      what you would want to have been told about.
//
// The schedule IS persisted, armed state included. That is a deliberate exception to
// the rule that armed is never remembered: a scheduler you have to re-arm after every
// restart is not a scheduler. The daily cap is what makes it survivable.

import { get, run, all } from './db.js';
import { parseFilters } from './profileSettings.js';
import { guardedAutoApplyRun } from './guardedAutoApply.js';
import { scanConnectors } from './scanRunner.js';
import { lcmd, linfo, lwarn, lerr } from './logger.js';

const timers = new Map();     // profileId -> timeout handle
const running = new Set();    // profileIds with a batch in flight

const MIN_MINUTES = 15;       // below this you are just hammering the boards
const MAX_MINUTES = 24 * 60;
const DEFAULT_DAILY_CAP = 30;

// How often a scheduled run also goes LOOKING for jobs.
//
// Applying without scanning empties the pool and then does nothing, which reads as
// "it can't find any new jobs" when the truth is that nothing went to look. Measured
// overnight: 145 applications between 20:00 and 02:00, after which Naukri had three
// candidates left and every later run was a no-op.
//
// Not every run, though — a LinkedIn scan walks four feeds and takes ~85s, so doing it
// every 20 minutes would spend most of the schedule scanning. Hourly keeps the pool fed
// without hammering either board.
const SCAN_EVERY_MINUTES = 60;
const SCAN_CONNECTORS = ['linkedin', 'naukri'];

export function defaultSchedule() {
  return {
    enabled: false, everyMinutes: 60, limit: 10, armed: false,
    dailyCap: DEFAULT_DAILY_CAP, scan: true, lastScanAt: 0,
  };
}

export function readSchedule(profile) {
  const s = parseFilters(profile).auto_apply_schedule;
  return { ...defaultSchedule(), ...(s && typeof s === 'object' ? s : {}) };
}

function clamp(cfg) {
  return {
    enabled: !!cfg.enabled,
    scan: cfg.scan !== false,
    lastScanAt: Number(cfg.lastScanAt) || 0,
    // Only the literal boolean arms it, exactly as the manual endpoint requires.
    armed: cfg.armed === true,
    everyMinutes: Math.max(MIN_MINUTES, Math.min(Number(cfg.everyMinutes) || 60, MAX_MINUTES)),
    limit: Math.max(1, Math.min(Number(cfg.limit) || 10, 25)),
    dailyCap: Math.max(1, Math.min(Number(cfg.dailyCap) || DEFAULT_DAILY_CAP, 200)),
  };
}

/** Applications actually sent since local midnight. Derived, never counted in memory. */
export async function sentToday(profileId) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const r = await get(
    "SELECT COUNT(*) AS n FROM jobs WHERE profile_id = ? AND auto_apply_state = 'applied' AND COALESCE(auto_applied_at, 0) >= ?",
    [profileId, midnight.getTime()]
  );
  return r?.n || 0;
}

export async function scheduleStatus(profileId) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) return null;
  const cfg = readSchedule(profile);
  const t = timers.get(profileId);
  return {
    ...cfg,
    running: running.has(profileId),
    nextRunAt: t?.__nextRunAt || null,
    sentToday: await sentToday(profileId),
  };
}

/** Persist and (re)start. Returns the effective config. */
export async function setSchedule(profileId, patch) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new Error('profile not found');
  const filters = parseFilters(profile);
  const cfg = clamp({ ...readSchedule(profile), ...patch });
  filters.auto_apply_schedule = cfg;
  // Only one unattended application scheduler may own a profile at a time. If the
  // legacy board-driven scheduler is enabled, disable the Sheet orchestrator in the
  // same persisted settings write. Its already-armed timer will re-read this state
  // before doing any work and stop itself.
  if (cfg.enabled && filters.orchestrator_schedule && typeof filters.orchestrator_schedule === 'object') {
    filters.orchestrator_schedule = {
      ...filters.orchestrator_schedule,
      enabled: false,
      armed: false,
    };
  }
  await run('UPDATE profiles SET filters = ? WHERE id = ?', [JSON.stringify(filters), profileId]);

  stop(profileId);
  if (cfg.enabled) {
    arm(profileId, cfg, cfg.everyMinutes * 60000);
    lcmd(profileId, cfg.armed
      ? `⏰ Auto-apply scheduled: up to ${cfg.limit} per board every ${cfg.everyMinutes} min — SENDING FOR REAL, capped at ${cfg.dailyCap}/day`
      : `⏰ Auto-apply scheduled: dry run of up to ${cfg.limit} per board every ${cfg.everyMinutes} min — nothing will be sent`);
    if (cfg.scan) lcmd(profileId, `⏰ It will also scan for new jobs at most once an hour, so the pool keeps refilling.`);
  } else {
    lcmd(profileId, '⏰ Auto-apply schedule stopped.');
  }
  return cfg;
}

/** Record that a scan just happened, without disturbing the rest of the config. */
async function stampScan(profileId) {
  try {
    const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
    if (!profile) return;
    const filters = parseFilters(profile);
    filters.auto_apply_schedule = { ...readSchedule(profile), lastScanAt: Date.now() };
    await run('UPDATE profiles SET filters = ? WHERE id = ?', [JSON.stringify(filters), profileId]);
  } catch { /* a missed stamp only means we scan again sooner */ }
}

export function stop(profileId) {
  const t = timers.get(profileId);
  if (t) clearTimeout(t);
  timers.delete(profileId);
}

function arm(profileId, cfg, delayMs) {
  const t = setTimeout(() => tick(profileId), delayMs);
  // Node keeps the process alive for pending timers; a scheduler should not be the
  // reason a server refuses to exit.
  if (typeof t.unref === 'function') t.unref();
  t.__nextRunAt = Date.now() + delayMs;
  timers.set(profileId, t);
}

async function tick(profileId) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]).catch(() => null);
  if (!profile) return stop(profileId);
  const cfg = readSchedule(profile);
  if (!cfg.enabled) return stop(profileId);

  // Re-arm FIRST, so a thrown run cannot silently end the schedule.
  arm(profileId, cfg, cfg.everyMinutes * 60000);

  if (running.has(profileId)) {
    lwarn(profileId, '⏰ Skipping this slot — the previous scheduled run is still going.');
    return;
  }

  if (cfg.armed) {
    const sent = await sentToday(profileId);
    if (sent >= cfg.dailyCap) {
      lwarn(profileId, `⏰ Daily cap reached (${sent}/${cfg.dailyCap} sent today) — holding until tomorrow.`);
      return;
    }
    // Never let one batch carry past the cap.
    cfg.limit = Math.min(cfg.limit, cfg.dailyCap - sent);
  }

  running.add(profileId);
  try {
    // Go looking first, when it is due. Otherwise the schedule works through what is
    // already there and then has nothing to do.
    if (cfg.scan && Date.now() - (cfg.lastScanAt || 0) > SCAN_EVERY_MINUTES * 60000) {
      lcmd(profileId, '⏰ Scheduled scan — looking for new jobs before applying');
      try {
        const scan = await scanConnectors(profile, SCAN_CONNECTORS);
        const found = scan.results.reduce((n, r) => n + (r.found || 0), 0);
        linfo(profileId, `⏰ Scan found ${found} new job(s).`);
      } catch (e) {
        lwarn(profileId, `⏰ Scheduled scan failed (${String(e?.message || e).slice(0, 90)}) — applying to what is already here.`);
      }
      // Stamped whether it worked or not: a board that is refusing us should not be
      // retried every twenty minutes.
      await stampScan(profileId);
    }

    lcmd(profileId, `⏰ Scheduled auto-apply — ${cfg.armed ? 'ARMED' : 'dry run'}, up to ${cfg.limit} per board`);
    const summary = await guardedAutoApplyRun(profile, { armed: cfg.armed, limit: cfg.limit });
    linfo(profileId, `⏰ Scheduled run done: ${summary.applied} applied · ${summary.dryRun} filled & held · `
      + `${summary.needsInput} waiting on you · ${summary.unconfirmed || 0} unconfirmed · ${summary.errors} error(s)`);
    if (summary.parked?.length) {
      lwarn(profileId, `⏰ ${summary.parked.length} question(s) need answering before more can go out.`);
    }
  } catch (e) {
    lerr(profileId, `⏰ Scheduled run failed: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    running.delete(profileId);
  }
}

/**
 * Resume saved schedules after a restart.
 *
 * The first run is deliberately delayed rather than fired immediately: a server that
 * restarts a few times while you edit settings should not send a burst of applications,
 * one per restart.
 */
export async function startAll() {
  let started = 0;
  try {
    for (const profile of await all('SELECT * FROM profiles')) {
      const cfg = readSchedule(profile);
      if (!cfg.enabled) continue;
      arm(profile.id, cfg, Math.min(cfg.everyMinutes, 5) * 60000);
      started++;
      console.log(`[JobFinder] ⏰ Auto-apply schedule resumed for "${profile.name}": `
        + `${cfg.armed ? 'ARMED — will SEND applications' : 'dry run'}, `
        + `up to ${cfg.limit} per board every ${cfg.everyMinutes} min, cap ${cfg.dailyCap}/day`);
    }
  } catch (e) {
    console.warn('[JobFinder] could not resume auto-apply schedules:', e?.message || e);
  }
  return started;
}
