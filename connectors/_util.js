import crypto from 'node:crypto';

export function jobId(connector, externalId) {
  return `${connector}:${crypto.createHash('sha1').update(externalId).digest('hex').slice(0, 16)}`;
}

export function buildKeywordQuery(profile) {
  const kws = (profile.keywords || '').split(',').map((s) => s.trim()).filter(Boolean);
  return kws.join(' OR ');
}

export function locationList(profile) {
  return [...new Set(
    (profile.locations || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )];
}

export function firstLocation(profile) {
  return locationList(profile)[0] || '';
}

// A field that is not on the page must be CHEAP to miss.
//
// These used to call innerText()/getAttribute() with no timeout, so a selector that no
// longer matched fell back to Playwright's 30s actionability default. Measured: exactly
// 30,002ms per missing field. LinkedIn and Naukri read 4-5 fields per card, so the very
// first card burned the connector's entire 120s budget and the scan reported "timed
// out" — when the real story was "the site changed its markup".
//
// 2.5s is far longer than a present element ever needs and short enough that a whole
// page of dead selectors costs seconds, not minutes.
const FIELD_TIMEOUT = 2500;

export async function safeText(loc, timeout = FIELD_TIMEOUT) {
  try { return (await loc.innerText({ timeout })).trim(); } catch { return ''; }
}

export async function safeAttr(loc, attr, timeout = FIELD_TIMEOUT) {
  try { return (await loc.getAttribute(attr, { timeout })) || ''; } catch { return ''; }
}

// Random delay between min and max milliseconds (human-like)
export function humanDelay(min = 1500, max = 3500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Flatten a field that *should* be a string array but might not be.
 *
 * Real APIs are inconsistent: Arbeitnow returns job_types as ["Full-time"] for most
 * rows but as an object {"1":"entry"} for others (21 of 175 in a sample). Calling
 * .join() on that threw and killed the whole connector mid-scan. Anything that
 * feeds a keyword haystack should go through this.
 */
export function toWords(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' || typeof v === 'number').join(' ');
  if (typeof value === 'object') return Object.values(value).filter((v) => typeof v === 'string' || typeof v === 'number').join(' ');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

/**
 * Record how many jobs a source returned BEFORE keyword filtering.
 *
 * Without this the scan log can't distinguish "the source is broken" from "the
 * source is fine, your keywords are narrow" — both show up as zero, and only one
 * of them is something you can act on.
 */
export function withFetched(jobs, fetched) {
  Object.defineProperty(jobs, 'fetched', { value: fetched, enumerable: false });
  return jobs;
}

// Normalized list of a profile's keywords, lowercased. [] means "no filter".
export function keywordList(profile) {
  return (profile.keywords || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// True if `text` contains ANY of the profile keywords (or if there are none).
export function matchesKeywords(text, keywords) {
  if (!keywords || !keywords.length) return true;
  const hay = String(text || '').toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

// Strip HTML tags → plain text, collapse whitespace, cap length. Many JSON job
// feeds return HTML in their description field; this makes it readable + storable.
export function htmlToText(html, max = 2000) {
  // Entities are decoded BEFORE tags are stripped, then tags are stripped again.
  //
  // The old order stripped first and decoded second, so markup that arrived escaped —
  // which is exactly how schema.org JobPosting descriptions ship it, as &lt;p&gt; —
  // survived stripping and then decoded into visible "<p>" litter in the job text.
  // Decoding first turns it into real markup that the tag pass then removes.
  const decoded = String(html || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');   // last, so &amp;lt; doesn't become a tag

  return decoded
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')   // keep paragraph breaks readable
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim()
    .slice(0, max);
}

// Shared fetch-JSON helper. Uses plain Node fetch — NO browser is launched. The
// API-based connectors are just HTTP GETs against public JSON endpoints, so there
// is no reason to spin up a Chrome window for them (doing so was launching a dozen
// browsers on "Scan All"). Returns null on any failure so connectors bail cleanly.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ── RSS / Atom ──────────────────────────────────────────────────────────────
// Several remote-job boards are WordPress sites whose only stable machine-readable
// surface is a feed. Shared here rather than copied per connector, because the fiddly
// parts (CDATA, entity decoding, Atom's href-attribute links) are identical every time.

const BROWSER_UA_RSS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    // Numeric entities too. WordPress feeds double-encode ampersands as &#038;, which
    // otherwise shows up verbatim in job titles ("Data Science &#038; Engineering").
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
}

/** Pull one tag's text out of a feed item. Handles CDATA and attributes. */
export function feedTag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

/** Atom puts the URL in an attribute (<link href="…"/>), RSS in the element body. */
export function feedLink(item) {
  const body = feedTag(item, 'link');
  if (body && /^https?:/i.test(body)) return body;
  const attr = item.match(/<link[^>]*href=["']([^"']+)["']/i);
  return attr ? decodeEntities(attr[1]) : body;
}

/**
 * Fetch a feed and return its raw <item>/<entry> chunks.
 * Returns [] rather than throwing — a dead feed should cost one source, not the scan.
 */
export async function fetchFeedItems(url, { timeoutMs = 20000 } = {}) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA_RSS, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const tag = /<item[\s>]/i.test(xml) ? 'item' : 'entry';
    return xml
      .split(new RegExp(`<${tag}[\\s>]`, 'i')).slice(1)
      .map((chunk) => chunk.split(new RegExp(`</${tag}>`, 'i'))[0]);
  } catch {
    return [];
  }
}

export async function fetchJson(url, { headers = {}, timeoutMs = 30000 } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// Fetch all jobs from a company's Greenhouse board (keyless public API).
// Returns a normalized array of { id, title, location, url, posted_at }.
export async function fetchGreenhouseBoard(slug) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (!data?.jobs) return [];
  return data.jobs.map((j) => ({
    id: String(j.id),
    title: j.title || '',
    location: j.location?.name || 'See posting',
    url: j.absolute_url || '',
    posted_at: j.updated_at || '',
  }));
}

// Fetch JSON THROUGH a logged-in browser context. Some sites (Reddit, LinkedIn)
// return 403 to plain server requests from datacenter IPs but serve normally to a
// real browser session that carries the user's cookies. Used by connectors whose
// endpoints are JSON but gated behind anti-bot / auth — they set requiresBrowser:true.
// Fetch JSON as the BROWSER would, not as Node would.
//
// page.request.get() looks like it goes through the browser, but it uses Playwright's
// own Node HTTP stack — Node's TLS fingerprint, Node's header order, no page origin.
// Reddit and Bluesky both fingerprint exactly that and return 403. Measured against
// reddit.com/r/forhire/new.json: page.request.get → 403, in-page fetch() → 200.
//
// So navigate to the origin first (real Chrome, real cookies) and run fetch() from
// inside the page. Same-origin, genuine browser TLS, and any session cookies apply.
export async function fetchJsonViaBrowser(ctx, url, { headers = {}, page: existing = null, origin = null } = {}) {
  if (!ctx) return null;
  const page = existing || (await ctx.newPage());
  try {
    const target = new URL(url);
    // `origin` lets a caller run the fetch from a DIFFERENT site than the API host.
    // Bluesky needs this: public.api.bsky.app refuses us outright, but the same query
    // against api.bsky.app succeeds when issued from a real bsky.app page.
    const from = origin ? new URL(origin) : target;

    let onOrigin = false;
    try { onOrigin = new URL(page.url()).origin === from.origin; } catch { /* about:blank */ }
    if (!onOrigin) {
      await page.goto(from.origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Settle before evaluating. Reddit redirects right after domcontentloaded, and
      // evaluating into a frame that is about to navigate throws "Execution context
      // was destroyed" — which is exactly what made this return null for r/*.
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    }

    const doFetch = async ({ href, hdrs, sameOrigin }) => {
      try {
        // Send cookies only on same-origin requests. A cross-origin fetch with
        // credentials:'include' requires the server to return
        // Access-Control-Allow-Credentials, and Bluesky's API does not — the request
        // dies in CORS preflight as a bare "Failed to fetch".
        const res = await fetch(href, {
          headers: { Accept: 'application/json', ...hdrs },
          credentials: sameOrigin ? 'include' : 'omit',
        });
        const text = await res.text();
        if (!res.ok) return { status: res.status, json: null };
        try { return { status: res.status, json: JSON.parse(text) }; }
        catch { return { status: res.status, json: null, notJson: text.slice(0, 200) }; }
      } catch (e) {
        return { status: 0, json: null, error: String(e && e.message) };
      }
    };

    let result;
    try {
      result = await page.evaluate(doFetch, { href: target.href, hdrs: headers, sameOrigin: from.origin === target.origin });
    } catch (e) {
      // Lost the context to a late navigation — let it land, then try once more.
      if (!/context was destroyed|Target closed|navigation/i.test(String(e?.message))) throw e;
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      result = await page.evaluate(doFetch, { href: target.href, hdrs: headers, sameOrigin: from.origin === target.origin });
    }

    if (!result || !result.json) {
      // Surface WHY rather than returning a bare null — a 403 and an empty result
      // are very different problems and the scan log should be able to say which.
      const why = result?.status ? `HTTP ${result.status}` : (result?.error || 'no response');
      fetchJsonViaBrowser.lastError = `${target.host}: ${why}`;
      return null;
    }
    return result.json;
  } catch (e) {
    fetchJsonViaBrowser.lastError = String(e?.message || e).slice(0, 160);
    return null;
  } finally {
    if (!existing) await page.close().catch(() => {});
  }
}

// A failure YOU can fix, tagged as such.
//
// A background scan is silent on purpose, which creates one problem: when a source
// needs you to sign in or clear a human-check, staying silent means the source just
// quietly returns nothing, forever. So walls are thrown with a marker, and the scan
// route surfaces exactly those — and only those — by opening a real window.
//
// `kind` is 'login' or 'captcha' (things you can resolve) or 'blocked' (things you
// cannot — those must NOT raise a window, since no amount of clicking fixes an IP ban).
export function wallError(kind, message) {
  const e = new Error(message);
  e.wall = kind;
  return e;
}

// Recognise the common "you are not getting in" pages so a connector can report
// something actionable instead of silently returning zero rows.
export async function detectWall(page) {
  try {
    const url = page.url();
    const txt = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 3000).toLowerCase();
    if (/access denied|you don't have permission|request unsuccessful/.test(txt)) return 'blocked';
    if (/\bsign in\b|\blog in\b|join now|create account/.test(txt) && /login|signin|authwall|challenge/.test(url)) return 'login';
    if (/verify (you are|you're) (a )?human|checking your browser|just a moment/.test(txt)) return 'captcha';
    if (/sign in to continue|please log in|log in to view/.test(txt)) return 'login';
    return null;
  } catch { return null; }
}

// Standard "this aggregator just redirects to the employer" apply handler.
// `ctx` is a real browser context here (Apply is user-initiated, one at a time, and
// the point is to SHOW the employer's page so the user can finish + autofill).
export function externalApply(note) {
  return async function apply(ctx, profile, job) {
    const page = await ctx.newPage();
    try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* still opened */ }
    return { status: 'opened', note: note || 'Opened — complete the application on the employer site.' };
  };
}

// Generic CAPTCHA waiter (recaptcha/hcaptcha/cloudflare). If found, perform a small
// pre-interaction humanization (mouse moves + scroll) — Cloudflare scores the absence
// of mouse activity as a strong bot signal — then wait up to `timeoutMs` for the
// challenge element to disappear (page passed) or wait for the user to solve it.
import { humanSettle, humanMouseTo } from '../lib/humanizer.js';

const CAPTCHA_SELECTORS = [
  // reCAPTCHA / hCaptcha
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.g-recaptcha',
  '.h-captcha',
  // Cloudflare (legacy + Turnstile)
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="cdn-cgi/challenge"]',
  '#challenge-running',
  '#challenge-stage',
  '#cf-challenge-running',
  'div.challenge-form',
  // PerimeterX
  '#px-captcha',
  // DataDome
  'iframe[src*="captcha-delivery"]',
  // Generic
  'iframe[src*="captcha"]',
  'iframe[src*="challenge"]',
  '[data-testid="challenge"]',
];

// Cloudflare-specific text that often appears even when an iframe selector isn't matched.
const CF_TEXT_PROBES = [
  'Verifying you are human',
  'Just a moment',
  'Checking your browser',
  'needs to review the security of your connection',
];

async function detectChallenge(page) {
  try {
    return await page.evaluate(({ selectors, texts }) => {
      if (selectors.some((s) => document.querySelector(s))) return true;
      const bodyText = (document.body?.innerText || '').slice(0, 4000);
      return texts.some((t) => bodyText.includes(t));
    }, { selectors: CAPTCHA_SELECTORS, texts: CF_TEXT_PROBES });
  } catch { return false; }
}

// Default lowered from 90s to 25s. Ninety seconds only pays off when a HUMAN is
// sitting there solving the challenge — during an unattended off-screen scan nobody
// is, so it was pure dead time, and with several browser sources queued it made
// scans appear to hang (LinkedIn and Naukri never reported at all). Challenges that
// clear automatically do so in well under 25s. Interactive flows can still pass a
// longer timeout explicitly.
export async function waitForCaptcha(page, { timeoutMs = 25000 } = {}) {
  const present = await detectChallenge(page);
  if (!present) return false;

  console.log('[JobFinder] Bot-check detected (Cloudflare / reCAPTCHA / hCaptcha). Settling page…');
  // Real users move the mouse a bit and scroll while the page loads — Cloudflare
  // weights this heavily. Doing it preemptively often lets invisible challenges pass.
  await humanSettle(page);

  // Some Cloudflare interstitials offer a checkbox at fixed coords (~30,30 within the
  // shadow-root iframe). We can't click into the iframe directly without anchor info,
  // but a mouse move into the general area helps the heuristic.
  await humanMouseTo(page, 200, 200).catch(() => {});

  const start = Date.now();
  let lastStateLog = 0;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const stillThere = await detectChallenge(page);
    if (!stillThere) {
      console.log('[JobFinder] Bot-check cleared.');
      return true;
    }
    if (Date.now() - lastStateLog > 10000) {
      lastStateLog = Date.now();
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[JobFinder] Bot-check still present (${elapsed}s) — solve it in the browser window if needed.`);
    }
  }
  console.log('[JobFinder] Bot-check timeout — continuing; downstream selectors may fail.');
  return true;
}
