import assert from 'node:assert/strict';
import { trackerRecordId, planDuplicateTrackerIdRepair } from '../lib/trackerRecordId.js';

const live = [
  ...Array.from({ length: 68 }, (_, i) => ({
    record_id: 'JF-linkedin',
    job_id: `linkedin:${String(i + 1).padStart(16, '0')}`,
    status: 'NOT_APPLIED',
    sheet_row: i + 2,
  })),
  ...Array.from({ length: 53 }, (_, i) => ({
    record_id: 'JF-arbeitno',
    job_id: `arbeitnow:${String(i + 1).padStart(16, '0')}`,
    status: 'ATS_QUEUED',
    sheet_row: i + 70,
  })),
  { record_id: 'CUSTOM-UNIQUE', job_id: 'other:1', status: 'APPLIED', sheet_row: 123 },
  { record_id: 'CUSTOM-DUP', job_id: 'other:2', status: 'APPLIED', sheet_row: 124 },
  { record_id: 'CUSTOM-DUP', job_id: 'other:2', status: 'NOT_APPLIED', sheet_row: 125 },
];
const original = JSON.parse(JSON.stringify(live));
const { collisions, repairs } = planDuplicateTrackerIdRepair('suryansh', live);
assert.equal(collisions.length, 3);
assert.equal(repairs.length, 123);
assert.deepEqual(live, original, 'planning must not mutate original job data');
assert.equal(trackerRecordId('linkedin:abc'), trackerRecordId('linkedin:abc'));
assert.notEqual(trackerRecordId('linkedin:abc'), trackerRecordId('linkedin:def'));
assert.equal(trackerRecordId('linkedin:abc').length, 27);
const proposed = new Map(repairs.map(({ row, replacement }) => [row.sheet_row, replacement]));
const finalIds = live.map((r) => proposed.get(r.sheet_row) || r.record_id);
assert.equal(new Set(finalIds).size, finalIds.length, 'every migrated row ID must be unique');
assert.equal(live[123].status, 'APPLIED');
assert.equal(planDuplicateTrackerIdRepair('suryansh', [{ record_id: 'unique', job_id: 'x', sheet_row: 2 }]).repairs.length, 0);
console.log('Tracker record IDs and duplicate migration plan: PASS');
