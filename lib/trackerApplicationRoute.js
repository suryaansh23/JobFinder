import { detectAts } from './atsDetector.js';

// Only routes with an implemented application engine may consume the fixed
// per-cycle application quota. Other vacancies remain visible in the tracker,
// but need a separate employer-site application workflow.
export function trackerApplicationRoute(row = {}) {
  const provider = detectAts(row.url || '').key;
  if (provider === 'greenhouse' || provider === 'lever' || provider === 'workday') return 'ats';

  const connector = String(row.connector || row.source || '').toLowerCase();
  const state = String(row.status || '').toUpperCase();
  const kind = String(row.apply_kind || '').toLowerCase();
  if ((connector === 'linkedin' || connector === 'naukri')
      && kind !== 'external' && state !== 'ATS_QUEUED') {
    return 'board';
  }
  return 'unsupported';
}
