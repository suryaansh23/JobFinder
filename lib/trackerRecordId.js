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

export function planDuplicateTrackerIdRepair(profileId, rows) {
  const occurrences = new Map();
  for (const row of rows) {
    const id = String(row.record_id || '').trim();
    if (id) occurrences.set(id, (occurrences.get(id) || 0) + 1);
  }
  const collisions = [...occurrences].filter(([, n]) => n > 1).map(([id]) => id);
  const collided = new Set(collisions);
  const alreadyUsed = new Set(rows.map((r) => String(r.record_id || '').trim()).filter(Boolean));
  const repairs = [];

  for (const row of rows) {
    if (!collided.has(String(row.record_id || '').trim())) continue;
    const identity = String(row.job_id || row.url || `${profileId}:${row.sheet_row}`);
    let replacement = trackerRecordId(identity, row.sheet_row);
    let attempt = 1;
    while (alreadyUsed.has(replacement)) {
      replacement = trackerRecordId(identity, `${row.sheet_row}:${attempt++}`);
    }
    alreadyUsed.add(replacement);
    repairs.push({ row, replacement });
  }

  return { collisions, repairs };
}
