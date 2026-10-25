import crypto from 'node:crypto';

// Stable full-identity hash. The old ID used job.id.slice(0, 8), which
// collapses every LinkedIn job into "JF-linkedin" and every Arbeitnow job
// into "JF-arbeitno". This is a business-key used for Sheet and DB mirroring.
export function trackerRecordId(jobId, salt = '') {
  const source = String(jobId || '');
  if (!source) throw new Error('Cannot build tracker record ID without a stable job identity');
  const payload = salt === '' ? source : `${source}|sheet-row:${salt}`;
  return 'JF-' + crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}
