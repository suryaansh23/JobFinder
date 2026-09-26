import { get, run } from './db.js';

let ready = null;

async function ensureTable() {
  if (!ready) {
    ready = run(`CREATE TABLE IF NOT EXISTS runtime_leases (
      lease_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      lease_until INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
}

export async function acquireLease(leaseKey, owner, ttlMs = 5 * 60 * 1000) {
  await ensureTable();
  const now = Date.now();
  const until = now + ttlMs;
  const result = await run(
    `INSERT INTO runtime_leases (lease_key, owner, lease_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(lease_key) DO UPDATE SET
       owner = ?, lease_until = ?, updated_at = ?
     WHERE runtime_leases.lease_until < ? OR runtime_leases.owner = ?`,
    [leaseKey, owner, until, now, owner, until, now, now, owner]
  );
  return result.changes > 0;
}

export async function renewLease(leaseKey, owner, ttlMs = 5 * 60 * 1000) {
  await ensureTable();
  const now = Date.now();
  const result = await run(
    `UPDATE runtime_leases
       SET lease_until = ?, updated_at = ?
     WHERE lease_key = ? AND owner = ?`,
    [now + ttlMs, now, leaseKey, owner]
  );
  return result.changes > 0;
}

export async function releaseLease(leaseKey, owner) {
  await ensureTable();
  await run('DELETE FROM runtime_leases WHERE lease_key = ? AND owner = ?', [leaseKey, owner]);
}

export async function leaseStatus(leaseKey) {
  await ensureTable();
  const row = await get('SELECT * FROM runtime_leases WHERE lease_key = ?', [leaseKey]);
  if (!row) return null;
  return { ...row, expired: Number(row.lease_until) < Date.now() };
}
