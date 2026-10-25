import assert from 'node:assert/strict';
import { isLinkedInAuthWallUrl } from '../lib/applyDiagnostics.js';

for (const url of [
  'https://www.linkedin.com/login',
  'https://www.linkedin.com/uas/login',
  'https://in.linkedin.com/authwall?trk=public_jobs',
  'https://www.linkedin.com/checkpoint/challenge/ABC',
  'https://www.linkedin.com/uas/login?session_redirect=foo',
]) assert.equal(isLinkedInAuthWallUrl(url), true, url);

for (const url of [
  'https://www.linkedin.com/jobs/view/1234567890/',
  'https://in.linkedin.com/jobs/view/1234567890?trk=login',
  'https://www.linkedin.com.evil.example/login',
  'https://example.org/login',
  'nonsense',
  '',
]) assert.equal(isLinkedInAuthWallUrl(url), false, url);

console.log('LinkedIn authentication-wall diagnostics: PASS');
