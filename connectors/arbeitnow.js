import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, externalApply, toWords, withFetched } from './_util.js';
import { relevantArbeitnowJob } from '../lib/jobRelevance.js';

// Arbeitnow — open job board API (EU + remote heavy), no key required.
// https://www.arbeitnow.com/api/job-board-api  (no server-side search; filter locally)
export default {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  loginUrl: 'https://www.arbeitnow.com/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const out = [];
    let fetchedCount = 0;
    // Walk a few pages so keyword filtering has enough to match against.
    for (let pageNum = 1; pageNum <= 3 && out.length < 60; pageNum++) {
      const data = await fetchJson(`https://www.arbeitnow.com/api/job-board-api?page=${pageNum}`);
      const jobs = data?.data || [];
      fetchedCount += jobs.length;
      if (!jobs.length) break;
      for (const j of jobs) {
        if (!j || !j.slug || !j.title) continue;
        if (!relevantArbeitnowJob(j, profile)) continue;
        const haystack = `${j.title} ${toWords(j.tags)} ${toWords(j.job_types)} ${htmlToText(j.description, 1500)}`;
        if (!matchesKeywords(haystack, kws)) continue;
        out.push({
          id: jobId('arbeitnow', j.slug),
          external_id: j.slug,
          title: j.title,
          company: j.company_name || '',
          location: j.location || (j.remote ? 'Remote' : ''),
          url: j.url || '',
          salary: '',
          posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : '',
          description: htmlToText(j.description),
        });
        if (out.length >= 60) break;
      }
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Arbeitnow redirects to the employer — complete the application there.'),
};
