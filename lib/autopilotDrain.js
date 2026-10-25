// Rolling LIVE drain: no arbitrary JobFinder per-cycle or daily application quota.
// Process the backlog in small, sequential, deduplicated batches until it is empty
// or the run's wall-clock budget is exhausted. Site restrictions and safety gates
// still take priority. There is intentionally NO "maximum applications" counter.
import { assessLiveHealth } from './autopilotPolicy.js';

export const LIVE_BATCH_SIZE = 10;
export const LIVE_WORK_WINDOW_MS = 35 * 60 * 1000;

export async function drainLiveQueue({
  runBatch,
  canContinue = async () => true,
  onBatch = async () => {},
  now = Date.now,
  batchSize = LIVE_BATCH_SIZE,
  workWindowMs = LIVE_WORK_WINDOW_MS,
}) {
  const until = now() + workWindowMs;
  const seen = new Set();
  const tally = { batches: 0, selected: 0, applied: 0, unconfirmed: 0, actionRequired: 0, failed: 0 };
  let reason = 'queue_empty';
  let health = { quarantine: false, blockers: [], failures: 0 };
  while (now() < until) {
    if (!(await canContinue())) { reason = 'schedule_paused'; break; }
    const report = await runBatch({ limit: batchSize, excludeJobIds: [...seen] });
    const ids = Array.isArray(report.selectedJobIds) ? report.selectedJobIds.filter(Boolean) : [];
    const selected = Number(report.selected || 0);
    if (!selected) { reason = 'queue_empty'; break; }
    tally.batches++;
    tally.selected += selected;
    tally.applied += Number(report.applied || 0);
    tally.unconfirmed += Number(report.unconfirmed || 0);
    tally.actionRequired += Number(report.actionRequired || 0);
    tally.failed += Number(report.failed || 0);
    await onBatch(report, tally);
    // A batch without attributable job IDs cannot be safely repeated.
    if (!ids.length) { reason = 'missing_selected_ids'; break; }
    let novel = 0;
    for (const id of ids) if (!seen.has(id)) { seen.add(id); novel++; }
    if (!novel) { reason = 'no_forward_progress'; break; }
    health = assessLiveHealth(report);
    if (health.quarantine) { reason = 'site_or_engine_blocked'; break; }
  }
  if (reason === 'queue_empty' && now() >= until) reason = 'time_budget';
  return { ...tally, reason, health, seen: seen.size };
}
