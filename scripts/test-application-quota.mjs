import assert from 'node:assert/strict';
import { normalizeApplicationQuota, availableApplicationBudget, quotaText } from '../lib/applicationQuota.js';

assert.equal(normalizeApplicationQuota(null, 10, 25), null);
assert.equal(normalizeApplicationQuota('unlimited', 30, 200), null);
assert.equal(availableApplicationBudget(null, null, 999), Number.MAX_SAFE_INTEGER);
assert.equal(quotaText(null), 'all eligible queued jobs');
assert.equal(normalizeApplicationQuota(10, 10, 25), 10);
assert.equal(normalizeApplicationQuota(500, 10, 25), 25);
assert.equal(normalizeApplicationQuota(0, 10, 25), 10);
assert.equal(normalizeApplicationQuota('invalid', 30, 200), 30);
assert.equal(availableApplicationBudget(10, 30, 28), 2);
assert.equal(availableApplicationBudget(10, 30, 30), 0);
assert.equal(availableApplicationBudget(null, 30, 28), 2);
assert.equal(availableApplicationBudget(10, null, 100), 10);
console.log('AUTOPILOT unlimited and legacy quota regression tests: PASS');
