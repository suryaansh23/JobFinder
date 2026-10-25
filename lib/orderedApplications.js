import { trackerApplicationRoute } from './trackerApplicationRoute.js';
import { detectAts } from './atsDetector.js';

export const PREPARATION_VERSION = 'persistent-session-2026-10-25';

export function retryAttempts(previous, state) {
  return Number(previous || 0) + (state === 'error' ? 1 : 0);
}

export function applicationChannel(row) {
  const route = trackerApplicationRoute(row);
  return route === 'board' ? row.connector : route === 'ats' ? detectAts(row.url || '').key : 'unsupported';
}

// Automatic readiness checks sample at most two jobs per provider, so a full
// page of fresh LinkedIn listings cannot starve the other application engines.
export function selectCanaryRows(rows, limit = 10) {
  const counts = new Map();
  return rows.filter((row) => {
    const key = applicationChannel(row);
    const n = counts.get(key) || 0;
    if (n >= 2) return false;
    counts.set(key, n + 1);
    return true;
  }).slice(0, limit);
}

// Rows arrive in Sheet order. One blocked provider cannot reorder, discard or
// repeatedly reopen its remaining jobs, or prevent another provider working.
export async function processOrderedApplications(rows, { execute, onStart, onResult }) {
  const channels = new Map();
  const results = [];
  for (const row of rows) {
    const channel = applicationChannel(row);
    if (!channels.has(channel)) channels.set(channel, {
      channel, selected: rows.filter((r) => applicationChannel(r) === channel).length,
      prepared: 0, errors: 0, confirmed: 0, unconfirmed: 0, blocked: [],
    });
    const health = channels.get(channel);
    if (health.blocked.length) continue;
    await onStart(row);
    const result = await execute(row);
    results.push({ job_id: row.job_id, channel, ...result });
    if (result.state === 'dry_run' && result.preparationValidated === true) health.prepared++;
    if (result.state === 'applied') health.confirmed++;
    if (result.state === 'submit_clicked') health.unconfirmed++;
    if (result.state === 'error') health.errors++;
    if (['ui_unavailable', 'auth_required', 'rate_limited'].includes(result.state)) health.blocked.push(result.state);
    if (health.errors >= 3) health.blocked.push('engine_errors');
    await onResult(row, result);
  }
  return { channels: [...channels.values()], results, preparationVersion: PREPARATION_VERSION };
}
