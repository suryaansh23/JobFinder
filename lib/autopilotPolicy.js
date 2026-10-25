import { PREPARATION_VERSION } from './orderedApplications.js';

// Evidence belongs to a provider and this engine version. A prepared Naukri
// button or old build cannot authorize LinkedIn or another ATS provider.
export function assessCanary(summary = {}) {
  const current = summary.preparationVersion === PREPARATION_VERSION;
  const channels = Array.isArray(summary.channels) ? summary.channels : [];
  const qualifiedChannels = current ? channels.filter((c) => {
    const required = Number(c.selected) < 2 ? 1 : 2;
    return Number(c.prepared) >= required && Number(c.errors || 0) <= 1
      && !Number(c.unconfirmed || 0) && !(c.blocked || []).length;
  }).map((c) => c.channel) : [];
  const prepared = channels.reduce((n, c) => n + Number(c.prepared || 0), 0);
  const errors = channels.reduce((n, c) => n + Number(c.errors || 0), 0);
  const blocked = channels.flatMap((c) => (c.blocked || []).map((b) => c.channel + ':' + b));
  const ready = qualifiedChannels.length > 0;
  const selected = Number(summary.selected || 0);
  const reason = ready ? 'Ready providers: ' + qualifiedChannels.join(', ')
    : !current ? 'This application engine needs its own automatic readiness check'
      : !selected ? 'No supported, relevant application routes are currently queued'
        : blocked.length ? 'Waiting for provider recovery: ' + blocked.join(', ')
          : 'Application preparation is not yet verified; automatic checks continue';
  return { ready, selected, prepared, errors, blocked, qualifiedChannels, reason };
}

export function assessLiveHealth(summary = {}) {
  const channels = summary.channels || [];
  const failures = channels.reduce((n, c) => n + Number(c.errors || 0), 0);
  const blockedChannels = channels.filter((c) => (c.blocked || []).length || Number(c.errors || 0) >= 3 || Number(c.unconfirmed || 0) > 0).map((c) => c.channel);
  const blockers = channels.flatMap((c) => (c.blocked || []).map((b) => c.channel + ':' + b));
  return { quarantine: blockedChannels.length > 0, blockedChannels, blockers, failures,
    reason: blockedChannels.length ? 'Provider needs a fresh automatic readiness check' : 'No systemic failure observed' };
}
