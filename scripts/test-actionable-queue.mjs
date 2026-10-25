import assert from 'node:assert/strict';
import { selectLifoRows } from '../lib/masterTracker.js';
import { trackerApplicationRoute } from '../lib/trackerApplicationRoute.js';
import { locationMatchesProfile, likelyMarketingConsultingTitle, relevantArbeitnowJob } from '../lib/jobRelevance.js';

const locs = 'Delhi NCR, Delhi, Gurugram, Noida, Jaipur, Chandigarh, Ludhiana, Remote, Hybrid, Dubai, Abu Dhabi, Riyadh, Jeddah, Doha, Muscat, Manama, Kuwait City';
for (const loc of ['Gurgaon, Haryana, India', 'New Delhi, India', 'Noida', 'Dubai, UAE', 'Remote', 'worldwide', 'Riyadh, Saudi Arabia']) {
  assert.equal(locationMatchesProfile(loc, locs), true, 'accepted ' + loc);
}
for (const loc of ['Paris, France', 'Zurich, Switzerland', 'Amsterdam, Netherlands', 'London, UK', 'Europe (Remote)', 'Bangalore, India', '']) {
  assert.equal(locationMatchesProfile(loc, locs), false, 'excluded ' + loc);
}
assert.equal(locationMatchesProfile('Paris', 'Paris, Remote'), true, 'preferences generalize');
assert.equal(likelyMarketingConsultingTitle('AI Unity Tools Engineer'), false);
assert.equal(likelyMarketingConsultingTitle('Senior Marketing Manager'), true);
assert.equal(likelyMarketingConsultingTitle('Strategy Consultant'), true);
assert.equal(relevantArbeitnowJob({title: 'AI Unity Tools Engineer', location: 'Paris'}, {locations: locs}), false);
assert.equal(relevantArbeitnowJob({title: 'Creative Marketing Manager', location: 'Paris'}, {locations: locs}), false);
assert.equal(relevantArbeitnowJob({title: 'Growth Marketing Lead', location: 'Remote'}, {locations: locs}), true);

const rows = Array.from({length: 10}, (_, i) => ({
  connector: 'arbeitnow', source: 'arbeitnow', status: 'NOT_APPLIED',
  apply_kind: 'external', url: 'https://www.arbeitnow.com/job/a-' + i,
  queued_at_ms: 5000-i, sheet_row: 10+i
})).concat(
  Array.from({length: 12}, (_, i) => ({
    connector: 'linkedin', source: 'linkedin', status: 'NOT_APPLIED',
    url: 'https://www.linkedin.com/jobs/view/' + (1234567890+i) + '/',
    queued_at_ms: 4000-i, sheet_row: 30+i
  }))
);
const before = JSON.stringify(rows);
const selected = selectLifoRows(rows, 10, {armed:false});
assert.equal(selected.length, 10);
assert.ok(selected.every((r) => trackerApplicationRoute(r) === 'board'));
assert.deepEqual(selected.map((r) => r.sheet_row), Array.from({length:10}, (_,i)=>30+i));
assert.equal(JSON.stringify(rows), before, 'selection cannot mutate tracker rows');

const ats = { connector:'arbeitnow', status:'ATS_QUEUED', url:'https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc', sheet_row:100, queued_at_ms:9000 };
const blockedExternal = {connector:'linkedin', status:'ATS_QUEUED', apply_kind:'external', url:'https://www.linkedin.com/jobs/view/999999999/', sheet_row:101, queued_at_ms:9999};
assert.equal(trackerApplicationRoute(ats), 'ats');
assert.equal(trackerApplicationRoute(blockedExternal), 'unsupported');
assert.equal(selectLifoRows([...rows,ats,blockedExternal], 1, {armed:false})[0].sheet_row,100);
console.log('Application-capable LIFO selection and Arbeitnow location/title filters: PASS');
