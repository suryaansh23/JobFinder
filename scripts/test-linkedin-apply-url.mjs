import assert from 'node:assert/strict';
import { linkedinOwnApplyUrl } from '../lib/linkedinApplyUrl.js';

const id='4482060285';
const good = [
  `https://www.linkedin.com/jobs/view/${id}/apply/?openSDUIApplyFlow=true`,
  `https://in.linkedin.com/jobs/view/${id}/apply`,
  `/jobs/view/${id}/apply?param=1`,
];
for (const candidate of good) {
  const result = linkedinOwnApplyUrl(id, candidate);
  assert.ok(result && result.includes('/jobs/view/' + id + '/apply'), 'should accept ' + candidate);
}
const bad = [
  'https://www.linkedin.com/jobs/view/9999999999/apply',
  'https://www.linkedin.com/jobs/view/' + id + '/',
  'https://www.linkedin.com.evil.example/jobs/view/' + id + '/apply',
  'https://evil.example/jobs/view/' + id + '/apply',
  'https://linkedin.com@evil.example/jobs/view/' + id + '/apply',
  '/jobs/view/' + id + '/apply-extra',
  'javascript:alert(1)',
  'nonsense',
];
for (const candidate of bad) assert.equal(linkedinOwnApplyUrl(id, candidate), null, 'must reject ' + candidate);
assert.equal(linkedinOwnApplyUrl('not-an-id','/jobs/view/1234567890/apply'),null);
console.log('LinkedIn same-job fallback URL validation: PASS');
