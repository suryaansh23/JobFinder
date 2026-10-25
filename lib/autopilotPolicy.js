// Shared, conservative go/no-go policy for unattended application scheduling.
// This is pure and regression-tested so the interactive controller and hourly
// scheduler cannot disagree on when real submissions are permitted.
export function assessCanary(summary = {}) {
  const engine = summary.engine || {};
  const ats = summary.ats || {};
  const prepared = Number(engine.dryRun || 0) + Number(ats.dryRun || 0);
  const selected = Number(summary.selected || 0);
  const errors = Number(engine.errors || 0) + Number(ats.errors || 0);
  const blocked = [
    ...(engine.loginRequired || []).map((s) => 'login:' + s),
    ...(engine.rateLimited || []).map((s) => 'rate-limit:' + s),
    ...(engine.uiUnavailable || []).map((s) => 'form-ui:' + s),
  ];
  const required = selected < 3 ? Math.min(selected, 1) : 2;
  const ready = selected > 0 && prepared >= required && errors <= 1 && blocked.length === 0;
  const reason = ready
    ? 'Safety gate passed: tested forms are filled without submission'
    : !selected ? 'No supported, relevant application routes are currently queued'
      : blocked.length ? 'Board needs attention: ' + blocked.join(', ')
        : prepared < required ? 'Prepared ' + prepared + ' of ' + required + ' required test forms'
          : 'Too many application-engine errors in test run';
  return { ready, selected, prepared, required, errors, blocked, reason };
}

export function assessLiveHealth(summary = {}) {
  const engine = summary.engine || {};
  const ats = summary.ats || {};
  const failures = Number(engine.errors || 0) + Number(ats.errors || 0);
  const blockers = [
    ...(engine.loginRequired || []).map((s) => 'login:' + s),
    ...(engine.rateLimited || []).map((s) => 'rate-limit:' + s),
    ...(engine.uiUnavailable || []).map((s) => 'form-ui:' + s),
  ];
  const quarantine = blockers.length > 0 || failures >= 3;
  return { quarantine, blockers, failures,
    reason: quarantine ? 'Application engine degraded; suspend LIVE until a new SAFE canary passes' : 'No systemic failure observed' };
}
