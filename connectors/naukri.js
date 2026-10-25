import { jobId, buildKeywordQuery, firstLocation, safeText, safeAttr, humanDelay, waitForCaptcha, detectWall, wallError } from './_util.js';

// Naukri sits behind Akamai bot protection. From a fresh automated browser it answers
// "Access Denied" (measured: HTTP 403) — it generally only works once you have logged
// in through "Open & log in" and that window is still open, which warms the session.
//
// Previously that 403 produced an empty page, every card selector missed, and each
// missing field waited out Playwright's 30s default — 5 fields deep, the connector
// blew its 120s budget and reported "timed out", telling you nothing useful. Now the
// block is detected up front and reported as the actionable thing it is.

export default {
  id: 'naukri',
  label: 'Naukri',
  loginUrl: 'https://www.naukri.com/nlogin/login',
  requiresAuth: true,
  requiresBrowser: true,

  async scan(ctx, profile) {
    const page = await ctx.newPage();
    const kw = (buildKeywordQuery(profile, { provider: 'naukri' }) || 'marketing').replace(/\s+/g, '-');
    const loc = firstLocation(profile).replace(/\s+/g, '-').toLowerCase();
    const url = `https://www.naukri.com/${encodeURIComponent(kw)}-jobs${loc ? `-in-${encodeURIComponent(loc)}` : ''}`;

    // ── Which of these can actually be applied to ON Naukri? ──────────────────
    //
    // Most Naukri results are "Apply on company site": the button just bounces you to
    // the employer's own careers page, so auto-apply can do nothing with them. Finding
    // that out by opening each posting costs ~5s a job and, before this, filled whole
    // batches with results nobody could act on.
    //
    // The search page asks Naukri's own API for the results it renders, and that answer
    // already contains the flag: companyApplyJob=true means the employer's site owns the
    // application. So read the response the page fetches anyway — no extra request, no
    // guessing at the API's required headers, and nothing to keep in sync if the card
    // markup changes again.
    const applyKind = new Map();   // numeric job id -> 'internal' | 'external'
    page.on('response', async (r) => {
      if (!/\/jobapi\/v\d\/search/.test(r.url())) return;
      try {
        const body = await r.json();
        for (const j of body.jobDetails || body.jobs || []) {
          if (!j || j.jobId == null) continue;
          applyKind.set(String(j.jobId), j.companyApplyJob ? 'external' : 'internal');
        }
      } catch { /* not the payload we wanted */ }
    });

    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    if (res && res.status() === 403) {
      await page.close().catch(() => {});
      throw wallError('login', 'Naukri blocked the request (Akamai "Access Denied"). Sign in on the window I opened, leave it open, then scan again.');
    }
    await waitForCaptcha(page);
    const wall = await detectWall(page);
    if (wall) {
      await page.close().catch(() => {});
      throw wall === 'blocked'
        ? wallError('blocked', 'Naukri blocked the request. Try again later — signing in will not help.')
        : wallError(wall, 'Naukri is asking you to sign in. Sign in on the window I opened, then scan again.');
    }
    await humanDelay(2500, 4500);

    // Naukri has shipped three card layouts; accept whichever is live.
    const cards = await page.locator('article.jobTuple, div.srp-jobtuple-wrapper, div.cust-job-tuple').all();
    if (!cards.length) {
      await page.close().catch(() => {});
      throw new Error('Naukri returned a page with no job cards — its markup has likely changed again.');
    }
    const out = [];
    for (const card of cards.slice(0, 25)) {
      const titleEl = card.locator('a.title, a.jobTitle').first();
      // NOTE: every safeText/safeAttr below is now capped at 2.5s (see _util.js), so a
      // stale selector costs seconds across the whole page instead of 30s per field.
      const title = await safeText(titleEl);
      const href = await safeAttr(titleEl, 'href');
      const company = await safeText(card.locator('a.subTitle, a.companyName, a.comp-name').first());
      const location = await safeText(card.locator('span.locWdth, span.location').first());
      const salary = await safeText(card.locator('span.salary, span.sal').first());
      if (!title || !href) continue;
      const ext = href.split('?')[0];
      // Naukri puts the numeric job id at the end of the slug, which is the same id the
      // search API keys its results by.
      const numeric = (ext.match(/(\d{6,})(?:\?|$)/) || [])[1] || '';
      out.push({
        id: jobId('naukri', ext),
        external_id: ext, title, company, location, url: href,
        salary, posted_at: '', description: '',
        apply_kind: applyKind.get(numeric) || null,
      });
    }
    // ── Recommendations ──────────────────────────────────────────────────────
    //
    // A keyword search is not where Naukri keeps the jobs you can actually apply to.
    // Measured on one profile: a "business consultant" search returned 24 postings, all
    // of them "Apply on company site". The signed-in recommendations are the opposite —
    // mostly jobs that are applied to on Naukri itself.
    //
    // AND THERE ARE FIVE OF THEM, NOT ONE.
    // The recommendations page is a set of tabs, and reading only the one that happens
    // to be open leaves most of the jobs on the table. Measured on the same profile:
    //
    //     Profile          52 jobs   35 apply on Naukri   (the tab that loads by default)
    //     Applies          34        27
    //     Top Candidate    56        46
    //     Preferences      64        53
    //     You might like   74        59
    //
    // So four fifths of the applyable jobs were never seen.
    //
    // Each tab POSTs to the same endpoint with a different clusterId. That request is
    // NOT reconstructed here: its body carries a clusterSplitDate map of server-issued
    // timestamps, and forging those means guessing at state Naukri owns. Clicking the
    // tab and reading what the page fetches is both simpler and honest — the browser
    // builds the correct request, we just listen.
    //
    // Additive and best-effort: it needs a signed-in session, and without one the
    // keyword results above stand exactly as before.
    try {
      const payloads = [];
      const onRecom = async (r) => {
        if (!/\/jobapi\/v\d\/search\/recom-jobs/.test(r.url())) return;
        try { payloads.push(await r.json()); } catch { /* not the payload */ }
      };
      page.on('response', onRecom);
      await page.goto('https://www.naukri.com/mnjuser/recommendedjobs', { waitUntil: 'domcontentloaded', timeout: 40000 });
      await humanDelay(4000, 6000);

      // Walk the remaining tabs. Index 0 is already loaded — clicking it fetches nothing.
      const tabCount = await page.evaluate(() => document.querySelectorAll('.tab-list-item').length).catch(() => 0);
      for (let i = 1; i < Math.min(tabCount, 8); i++) {
        const clicked = await page.evaluate((idx) => {
          const tabs = document.querySelectorAll('.tab-list-item');
          if (!tabs[idx]) return false;
          tabs[idx].click();
          return true;
        }, i).catch(() => false);
        if (!clicked) break;
        await humanDelay(3000, 4500);   // the tab fetches after the click
      }
      page.off('response', onRecom);

      let added = 0;
      for (const payload of payloads) {
        for (const j of (payload?.jobDetails || [])) {
          if (!j || !j.jdURL || !j.title) continue;
          const url = j.jdURL.startsWith('http') ? j.jdURL : `https://www.naukri.com${j.jdURL}`;
          const ext = url.split('?')[0];
          if (out.some((x) => x.external_id === ext)) continue;   // tabs overlap heavily
          const place = (type) => (j.placeholders || []).find((x) => x.type === type)?.label || '';
          out.push({
            id: jobId('naukri', ext),
            external_id: ext,
            title: j.title,
            company: j.companyName || '',
            location: place('location'),
            url,
            salary: place('salary'),
            posted_at: j.createdDate ? new Date(j.createdDate).toISOString() : '',
            description: j.jobDescription || '',
            // Straight from Naukri: false means the application is completed on Naukri.
            apply_kind: j.companyApplyJob ? 'external' : 'internal',
          });
          added++;
        }
      }
      if (added) console.log(`[naukri] ${added} job(s) from ${payloads.length} recommendation tab(s)`);
    } catch { /* signed out or endpoint moved — keyword results stand */ }

    // ── Early access roles ───────────────────────────────────────────────────
    //
    // "Exclusive opportunities based on what recruiters are searching for, even before
    // they post a job." Naukri calls them pseudojobs internally, and they are the
    // earliest anything is visible — worth reaching before a posting exists and the
    // queue forms behind it.
    //
    // They work differently from a normal listing, in a way that matters: there is no
    // Apply button. The action is "Share Interest", which registers you with the
    // recruiter. lib/autoApply.js handles that separately.
    //
    // Note these carry NO companyApplyJob field at all, so the usual `!companyApplyJob`
    // test would call them internal by accident rather than on purpose. They are marked
    // explicitly here, because Share Interest genuinely does happen on Naukri.
    try {
      let early = null;
      const onEarly = async (r) => {
        if (!/\/jobapi\/v\d\/search\/pseudojobs/.test(r.url())) return;
        try { early = await r.json(); } catch { /* not the payload */ }
      };
      page.on('response', onEarly);
      await page.goto('https://www.naukri.com/mnjuser/recommended-earjobs', { waitUntil: 'domcontentloaded', timeout: 40000 });
      await humanDelay(4000, 6000);
      page.off('response', onEarly);

      for (const j of (early?.jobDetails || [])) {
        if (!j || !j.jdURL || !j.title) continue;
        const url = j.jdURL.startsWith('http') ? j.jdURL : `https://www.naukri.com${j.jdURL}`;
        const ext = url.split('?')[0];
        if (out.some((x) => x.external_id === ext)) continue;
        const place = (type) => (j.placeholders || []).find((x) => x.type === type)?.label || '';
        out.push({
          id: jobId('naukri', ext),
          external_id: ext,
          title: j.title,
          company: j.companyName || j.companyTags?.[0] || 'Early access role',
          location: place('location'),
          url,
          salary: place('salary'),
          posted_at: j.createdDate ? new Date(j.createdDate).toISOString() : '',
          description: j.jobDescription || '',
          apply_kind: 'internal',
          early_access: true,
        });
      }
    } catch { /* signed out or the section moved — everything above still stands */ }

    await page.close();
    return out;
  },

  async apply(ctx, profile, job) {
    const page = await ctx.newPage();
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await waitForCaptcha(page);
    await humanDelay(1000, 2500);
    const btn = page.locator('button:has-text("Apply"), #apply-button').first();
    if (await btn.count()) await btn.click().catch(() => {});
    return { status: 'opened', note: 'Naukri job opened — confirm application in browser.' };
  },
};
