import { randomUUID } from 'node:crypto';
import { autoApplyRun } from './autoApply.js';
import { acquireLease, renewLease, releaseLease } from './runtimeLease.js';

const LEASE_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

export async function guardedAutoApplyRun(profile, options = {}) {
  const leaseKey = `autoapply:${profile.id}`;
  const owner = `${process.pid}:${randomUUID()}`;
  const acquired = await acquireLease(leaseKey, owner, LEASE_TTL_MS);

  if (!acquired) {
    const e = new Error('Another auto-apply run is already active for this profile.');
    e.code = 'AUTOAPPLY_BUSY';
    throw e;
  }

  const heartbeat = setInterval(() => {
    renewLease(leaseKey, owner, LEASE_TTL_MS).catch(() => {});
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return await autoApplyRun(profile, options);
  } finally {
    clearInterval(heartbeat);
    await releaseLease(leaseKey, owner).catch(() => {});
  }
}
