// A null quota explicitly opts in to no fixed internal application count limit.
// Existing numeric schedule configurations retain capped behavior.
export function normalizeApplicationQuota(value, fallback, maximum) {
  if (value === null || value === 'unlimited') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, maximum);
}

// The maximum safe integer represents all jobs in a finite tracker snapshot.
// It is only used for selecting rows, never for repeating an application.
export function availableApplicationBudget(limit, dailyCap, alreadySent = 0) {
  const perRun = limit === null ? Number.MAX_SAFE_INTEGER : limit;
  const remaining = dailyCap === null
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, dailyCap - alreadySent);
  return Math.min(perRun, remaining);
}
export function quotaText(limit) {
  return limit === null ? 'all eligible queued jobs' : 'up to ' + limit;
}
