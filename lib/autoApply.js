// Auto-apply: complete LinkedIn Easy Apply and Naukri on-site applications end to end.
//
// This is the only part of JobFinder that presses a button an employer sees. Everything
// here is shaped by that one fact.
//
// THE RULE THAT DECIDES EVERYTHING
// If the form asks something the answer bank cannot answer, we STOP. We do not let the
// LLM invent a reply. A drafted paragraph about why you want the job is a writing task
// and the model is good at it; "how many years of Kubernetes do you have" is a fact
// about you, and a model that has never met you cannot supply it. Getting that wrong is
// not a cosmetic bug — it is a false statement on a real application, sent under your
// name, that you cannot retract.
//
// So unanswerable questions are parked in the answer bank with status 'needs_input'
// (see parkQuestion), the application is abandoned before submitting, and the job is
// left to be retried. Answer the question once and every job blocked on it unblocks,
// because questions are keyed by field_key exactly like ordinary answers.
//
// TWO SITES, TWO DIFFERENT DANGERS
//   LinkedIn — a multi-step wizard. Safe to walk through; nothing is sent until the
//     final "Submit application". We can fill, inspect, screenshot, and back out.
//   Naukri  — clicking "Apply" IS the submission. There is no review step to stop at.
//     So on Naukri a dry run must not click at all; it reports what it would do.
//
// DRY RUN IS THE DEFAULT
// armed=false fills everything, screenshots the completed form and stops. You look at
// the screenshots, and only then arm it. The first time this runs against a real
// employer should not also be the first time anyone has seen its output.

import fs from 'node:fs';
import path from 'node:path';
import { get, run, all } from './db.js';
import { getContext } from './browser.js';
import { retrieve } from './knowledge.js';
import { answersAsMap, parkQuestion, canonicalKey } from './answerBank.js';
import { derivedAnswer } from './derivedAnswers.js';
import { salaryAnswer, isSalaryExpectationField } from './salaryExpectation.js';
import { isIdentityKey, validateIdentity } from './identity.js';
import { linfo, lok, lwarn, lerr } from './logger.js';
import { dataPath } from './paths.js';

// Same bar autofill uses for filling a field verbatim from the bank. Deliberately not
// lowered for auto-apply: this path has less human oversight, not more.
const SEMANTIC_CONFIDENT = 0.55;

// A wizard that has not finished in this many steps is not a wizard we understand.
const MAX_STEPS = 12;

// Attempts before a posting is set aside.
//
// Some forms simply cannot be completed by this code — a widget it cannot drive, a
// question whose answer the site keeps rejecting. Without a limit, each of those
// occupies a slot in every run forever, and a batch of ten becomes a batch of ten
// known failures. Three attempts is one try plus two retries, which is enough to
// survive a transient failure and not enough to waste a batch.
const MAX_ATTEMPTS = 3;

// How many postings to open at once per board, during a dry run.
//
// Not the same number for both. LinkedIn throttles: three concurrent tabs produced
// ERR_HTTP_RESPONSE_CODE_FAILURE on half a batch, which is LinkedIn refusing the
// request, not the posting being broken. Naukri tolerated three without complaint.
const DRY_WIDTH = { linkedin: 2, naukri: 3 };

// Failures that say nothing about the posting — the site refused us, the network
// wobbled, a page took too long. These must not count against a job's retry budget or
// mark it as failed, or a rate-limited afternoon would permanently discard good jobs.
const TRANSIENT_RE = /ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_ABORTED|net::|429|timeout|Timeout|socket hang up/;

export function isTransient(note = '') {
  return TRANSIENT_RE.test(String(note));
}

// Buttons that send the application. Matched defensively and never clicked unless
// armed — an unexpected label here is the difference between a dry run and 10 live
// applications.
const SUBMIT_RE = /^(submit application|submit|send application)$/i;
const ADVANCE_RE = /^(continue to next step|next|review your application|review|continue)$/i;

/**
 * page.evaluate that survives a navigation.
 *
 * These flows navigate under us constantly — following the apply link, pressing Next,
 * the SPA swapping routes — and any evaluate in flight when that happens throws
 * "Execution context was destroyed". Every read here is best-effort by nature, so a
 * torn-down context should yield the fallback, not abort an application mid-way.
 */
async function safeEval(page, fn, arg, fallback = null) {
  try {
    return await page.evaluate(fn, arg);
  } catch { return fallback; }
}

export function shotDir(profileId) {
  const dir = dataPath('applications', profileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function shoot(page, profileId, jobId, tag) {
  try {
    const file = path.join(shotDir(profileId), `${jobId}-${tag}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

/** LinkedIn job ids are the long number in any of its many URL shapes. */
export function linkedinJobId(url = '') {
  const m = String(url).match(/(?:jobs\/view\/|currentJobId=)[^0-9]*(\d{6,})/) || String(url).match(/(\d{9,})/);
  return m ? m[1] : null;
}

/**
 * Decide what an answer for this field should be, using ONLY the answer bank.
 *
 * Returns { value } when we know it, or { missing: true } when we do not. There is
 * deliberately no third branch that asks an LLM — see the note at the top of the file.
 *
 * For a dropdown the value additionally has to BE one of the offered options, so a
 * known answer that does not match any choice is treated as unknown rather than
 * jammed in: setting a <select> to a value it does not have silently sets nothing.
 */
/** Your baseline expectation, in your own currency, from the answer bank. */
function baseExpectation(exactMap) {
  for (const k of ['expected ctc', 'expected salary', 'desired compensation', 'desired salary']) {
    const n = Number(String(exactMap[k] || '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export async function resolveAnswer(profile, target, exactMap, job = {}) {
  // A salary expectation is currency-dependent, so it cannot come from the bank as-is.
  //
  // The bank holds one figure in one currency. Typing it into a form in Berlin is not a
  // rounding error, it is a number roughly thirty times too large — the kind of answer
  // that ends a conversation. See lib/salaryExpectation.js for why the conversion is by
  // purchasing power rather than exchange rate.
  if (isSalaryExpectationField(target.label || target.key)) {
    const base = baseExpectation(exactMap);
    if (base) {
      const sal = salaryAnswer(target.label || target.key, {
        job, baseAmount: base, baseCurrency: 'INR', overrides: exactMap,
      });
      // A currency we cannot identify is asked about, never guessed at.
      if (sal?.unknownCurrency) return { missing: true, reason: 'currency-unknown', detail: sal.why };
      if (sal?.value) return { value: sal.value, derived: sal.why };
    }
  }

  // Other computed answers come next, and outrank the bank.
  //
  // "Notice period" is the case: it is derived from your last working day, so it is
  // correct today and correct in three weeks. A number stored in the bank is a snapshot
  // that silently rots, and it rots in the direction that matters — a recruiter plans
  // around the figure you gave them.
  const derived = derivedAnswer(profile, target.label || target.key, { type: target.type, options: target.options });
  if (derived) return { value: derived.value, derived: derived.why };

  const key = canonicalKey(target.key || target.label, target.type);
  let value = key ? exactMap[key] : null;

  // Second gate, at the moment of filling.
  //
  // The first gate stops a wrong value being SAVED under a personal field. This one
  // stops a wrong value being USED, which matters because a bank can already be corrupt
  // — this one was — and because the point of failure is an employer's form. If the
  // stored email is not an email, it is treated as missing and you are asked, rather
  // than "Yes" being typed into the address box.
  if (value && isIdentityKey(key)) {
    const v = validateIdentity(key, value);
    if (!v.ok) return { missing: true, reason: 'identity-invalid', detail: `saved ${key} is "${String(value).slice(0, 20)}" — ${v.why}` };
  }

  if (!value) {
    try {
      const { hits, exact } = await retrieve(profile, target.label || target.key, { k: 4 });
      if (exact?.value) value = exact.value;
      else if (hits[0] && hits[0].score >= SEMANTIC_CONFIDENT) value = hits[0].value;
    } catch { /* retrieval offline — treat as unknown, never as "fill anything" */ }
  }
  if (!value) return { missing: true };

  if (target.options && target.options.length) {
    const real = target.options.filter(
      (o) => o && !/^(select|please select|please choose|choose)\b/i.test(o.trim()) && !/^-+/.test(o.trim())
    );
    if (!real.length) return { missing: true, reason: 'no-option-match', have: String(value).slice(0, 60) };
    target = { ...target, options: real };
    const want = String(value).trim().toLowerCase();
    const hit = target.options.find((o) => o.trim().toLowerCase() === want)
      || target.options.find((o) => o.trim().toLowerCase().includes(want))
      || (/^(yes|no)$/i.test(want)
        ? target.options.find((o) => o.trim().toLowerCase() === want)
        : null);
    // We DO have an answer, it just is not one of the offered choices — a city for a
    // dropdown listing only other cities, or "3 years" where the options are ranges.
    // Flagged distinctly so the caller re-parks it WITH the choices attached; treating
    // it as ordinary "missing" makes parkQuestion refuse it as already-known and the
    // question then never reaches you, while the run keeps reporting it as blocking.
    if (!hit) return { missing: true, reason: 'no-option-match', have: String(value).slice(0, 60) };
    return { value: hit };
  }
  return { value };
}

/**
 * A fingerprint of the current wizard step.
 *
 * LinkedIn does not tell you it refused to advance. If a required field is empty it
 * simply does nothing when you press Next — same dialog, same percentage, no error we
 * can see. Comparing this before and after the click is the only reliable way to know
 * whether anything happened.
 */
async function stepSignature(page, rootSelector) {
  try {
    return await page.evaluate(({ root }) => {
      const d = document.querySelector(root);
      if (!d) return 'gone';
      const pct = (d.innerText.match(/(\d+)%/) || [])[0] || '';
      const names = [...d.querySelectorAll('input,select,textarea')]
        .filter((e) => e.type !== 'hidden').map((e) => e.id || e.name || e.type).join(',');
      return `${pct}|${names}`;
    }, { root: rootSelector });
  } catch { return 'err'; }
}

/** Read the visible fields inside `rootSelector` using the injected observer. */
async function scanFields(page, rootSelector) {
  try {
    return await page.evaluate(
      ({ root }) => (window.__jobfinderFill ? window.__jobfinderFill({}, { root, overwrite: false }) : null),
      { root: rootSelector }
    );
  } catch { return null; }
}

// Write one field through the observer's setter, which re-validates at write time —
// the same guard ordinary autofill relies on, and the reason a value never lands in
// the wrong box when a framework re-renders the form between scan and write.
async function setField(page, target, value) {
  try {
    return await page.evaluate(
    ({ sel, fallback, val }) => {
      if (!window.__jobfinderSetByPath) return { ok: false, reason: 'setter missing' };
      const r = window.__jobfinderSetByPath(sel, val);
      if (r && r.ok) return r;
      // The token selector is stamped at scan time; if the element was re-created since,
      // fall back to the structural path before giving up.
      return fallback ? window.__jobfinderSetByPath(fallback, val) : r;
    },
      { sel: target.selector, fallback: target.fallbackSelector, val: value }
    );
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 60) }; }
}

/**
 * Fill a field and CONFIRM it took.
 *
 * Writing .value is enough for an ordinary input, and wrong for a typeahead. LinkedIn's
 * "Location (city)" is an autocomplete: it keeps its real answer in React state, which
 * only updates from genuine keystrokes plus a chosen suggestion. Write to it directly
 * and the box shows your text while the form still considers it empty — so Next does
 * nothing, forever, with no error. That is a silent failure the earlier loop could not
 * distinguish from "no button here", so it is checked explicitly.
 *
 * Returns { ok } — and ok means the value is actually in the field afterwards, not
 * merely that a write was attempted.
 */
async function fillAndVerify(page, target, value) {
  const isTypeahead = /typeahead/i.test(target.selector || '')
    || /typeahead/i.test(target.fallbackSelector || '')
    || await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return el.getAttribute('role') === 'combobox'
        || !!el.getAttribute('aria-autocomplete')
        || /typeahead/i.test(el.id || '');
    }, target.selector).catch(() => false);

  // A <select> is set through Playwright, not through a synthetic change event.
  //
  // LinkedIn's dropdowns are React-controlled: assigning selectedIndex and dispatching
  // change updates what the box SHOWS while React's own state stays on the placeholder,
  // so the step keeps failing validation and Next silently does nothing. selectOption
  // drives it the way a person does, and the component actually registers the choice.
  const isSelect = target.type === 'select'
    || await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return !!el && el.tagName === 'SELECT';
    }, target.selector).catch(() => false);

  if (isSelect) {
    try {
      const loc = page.locator(target.selector).first();
      await loc.selectOption({ label: String(value) }, { timeout: 8000 });
      await page.waitForTimeout(400);
      const now = await safeEval(page, (sel) => {
        const el = document.querySelector(sel);
        const o = el && el.options ? el.options[el.selectedIndex] : null;
        return o ? (o.text || '').trim() : '';
      }, target.selector, '');
      return { ok: now.toLowerCase() === String(value).trim().toLowerCase(), how: 'select', reason: now ? `shows "${now}"` : 'no option selected' };
    } catch (e) {
      return { ok: false, reason: `selectOption failed: ${String(e?.message || e).slice(0, 60)}` };
    }
  }

  if (!isTypeahead) {
    const r = await setField(page, target, value);
    const stuck = await page.evaluate(
      ({ sel, val }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const want = String(val).trim().toLowerCase();
        // A <select> is confirmed by its SELECTED OPTION, not by .value. LinkedIn's
        // option values are URNs while the visible text is "1 year", so comparing
        // .value to what we asked for reports failure on a dropdown that is set
        // perfectly well — and the run then blames a field that is actually fine.
        if (el.tagName === 'SELECT') {
          const o = el.options[el.selectedIndex];
          return !!o && (o.text.trim().toLowerCase() === want || String(o.value).trim().toLowerCase() === want);
        }
        return String(el.value || '').trim() === String(val).trim();
      }, { sel: target.selector, val: value }
    ).catch(() => false);
    if (stuck) return { ok: true, how: 'direct' };
    if (r?.ok && !stuck) return { ok: false, reason: 'value did not stick' };
    return r || { ok: false };
  }

  // Typeahead: type it like a person, then take the suggestion the site offers.
  try {
    const loc = page.locator(target.selector).first();
    await loc.click({ timeout: 8000 });
    await loc.fill('');
    await loc.pressSequentially(String(value).slice(0, 60), { delay: 90 });
    await page.waitForTimeout(1600);
    const opt = page.locator('[role="option"], [role="listbox"] li').first();
    if (await opt.count().catch(() => 0)) {
      await opt.click({ timeout: 5000 });
    } else {
      await loc.press('ArrowDown');
      await loc.press('Enter');
    }
    await page.waitForTimeout(600);
    const filled = await safeEval(page, (sel) => {
      const el = document.querySelector(sel);
      return !!el && !!String(el.value || '').trim();
    }, target.selector, false);
    return { ok: filled, how: 'typeahead', reason: filled ? undefined : 'no suggestion accepted' };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 80) };
  }
}

/**
 * Ask the FORM why it refused, instead of guessing.
 *
 * When a step will not advance, the site almost always says why — an inline error under
 * the offending field, and aria-invalid on the control. Reading that is far better than
 * inferring, because it distinguishes the two cases that look identical from outside:
 * a field we left empty, and a field we filled with something the site rejects (a
 * stored answer that is the wrong shape, like a plain word where a URL is required).
 *
 * The second case matters: the answer bank HAS an answer, so nothing looks missing, and
 * without this the run would report "everything is answered" while the form disagrees.
 */
async function validationErrors(page, rootSelector) {
  try {
    return await page.evaluate(({ root }) => {
      const d = document.querySelector(root);
      if (!d) return [];
      // Same doubled-label problem the observer has: a visible <label> plus an
      // aria-label on the same control concatenate into "Total years Total years",
      // which becomes a key nothing else ever matches. Collapse it here too — this
      // walker is independent of the observer's, so it needs its own copy.
      const collapse = (str) => {
        const w = String(str || '').trim().split(/\s+/);
        if (w.length < 4) return String(str || '').trim();
        for (let k = w.length - 2; k >= 2; k--) {
          const head = w.slice(0, k).join(' ');
          const tw = w.slice(k);
          if (tw.length < 2) continue;
          const tail = tw.join(' ');
          if (head.length >= tail.length && head.toLowerCase().indexOf(tail.toLowerCase()) === 0) return head;
        }
        return w.join(' ');
      };
      const labelFor = (el) => {
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l && l.innerText.trim()) return collapse(l.innerText.replace(/\s+/g, ' ').trim());
        }
        const al = el.getAttribute('aria-label');
        if (al) return collapse(al.trim());
        let n = el.parentElement;
        for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
          const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
          if (t && t.length < 140) return collapse(t);
        }
        return '';
      };
      const out = [];
      d.querySelectorAll('input,select,textarea').forEach((el) => {
        if (el.type === 'hidden') return;
        const invalid = el.getAttribute('aria-invalid') === 'true';
        // The error node is usually described by aria-describedby, or sits alongside.
        let msg = '';
        const desc = el.getAttribute('aria-describedby');
        if (desc) {
          desc.split(/\s+/).forEach((idr) => {
            const n = document.getElementById(idr);
            const t = n && (n.innerText || '').trim();
            if (t && /required|valid|enter|select|must/i.test(t)) msg = t.replace(/\s+/g, ' ').slice(0, 120);
          });
        }
        if (!invalid && !msg) return;
        // If it is a dropdown, carry the choices out with it. A question that reaches
        // you as "pick one" without saying what the options are is unanswerable, and
        // any value you type that is not on the list will be rejected again — which is
        // exactly the loop this is here to break.
        let options = null;
        if (el.tagName === 'SELECT') {
          options = [...el.options]
            .map((o) => (o.text || '').trim())
            // Drop the "Select an option" prompt — it is not an answer, and a form set
            // to it stays invalid while appearing filled.
            .filter((o) => o && !/^(select|please select|please choose|choose)\b/i.test(o) && !/^-+/.test(o))
            .slice(0, 60);
        }
        out.push({
          // The scan stamps data-jf-target on every field it offered. Carrying it out
          // here lets the caller recover the SAME key the scan used, instead of
          // deriving a second one from a different label walker — two keys for one
          // question means you answer it under one and the run keeps asking under the
          // other, forever.
          token: el.getAttribute('data-jf-target') || '',
          label: labelFor(el).slice(0, 90),
          value: String(el.value || '').slice(0, 40),
          error: msg || 'marked invalid',
          id: el.id || '',
          options,
        });
      });
      return out;
    }, { root: rootSelector });
  } catch { return []; }
}

/** The buttons currently offered by the apply dialog, in DOM order. */
async function dialogButtons(page, rootSelector) {
  try {
    return await page.evaluate(({ root }) => {
      const scope = (root && document.querySelector(root)) || document;
      return [...scope.querySelectorAll('button')]
        .filter((b) => !b.disabled && (b.offsetWidth || b.offsetHeight))
        .map((b) => ({
          text: (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          aria: (b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((b) => b.text);
    }, { root: rootSelector });
  } catch { return []; }
}

// Every DOM call here can land mid-navigation — clicking Next or Submit tears the
// execution context down under us, and Playwright turns that into a thrown error that
// would abort the whole job. These are all best-effort by nature, so a destroyed
// context means "could not do it", not "crash the run".
async function clickByText(page, rootSelector, re) {
  try {
    return await page.evaluate(({ root, src, flags }) => {
      const rx = new RegExp(src, flags);
      const scope = (root && document.querySelector(root)) || document;
      const b = [...scope.querySelectorAll('button')]
        .filter((x) => !x.disabled && (x.offsetWidth || x.offsetHeight))
        .find((x) => rx.test((x.innerText || x.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
      if (!b) return false;
      b.click();
      return true;
    }, { root: rootSelector, src: re.source, flags: re.flags });
  } catch { return false; }
}

// ── LinkedIn ────────────────────────────────────────────────────────────────
//
// LinkedIn replaced the old `.jobs-easy-apply-modal` with a server-driven flow whose
// class names are build hashes (`bb9bff38 _7917aabf …`), so nothing here keys off a
// class. It keys off role="dialog", visible button text, and the form-element id
// prefixes that survived the rewrite. Easy Apply is also an <a>, not a <button>.
const LI_DIALOG = 'div[role="dialog"]';

async function linkedinApply(page, profile, job, { armed, exactMap, pid }) {
  const id = linkedinJobId(job.url);
  if (!id) return { state: 'skipped', note: 'no LinkedIn job id in the URL' };

  // One retry with a pause. LinkedIn's refusals are momentary, and giving up on the
  // first one throws away a job that would have loaded a second later.
  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt++) {
    try {
      await page.goto(`https://www.linkedin.com/jobs/view/${id}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      opened = true;
    } catch (e) {
      if (attempt === 1 || !isTransient(e?.message)) throw e;
      await page.waitForTimeout(4000 + Math.random() * 4000);
    }
  }
  await page.waitForTimeout(2500);

  // Is THIS job Easy Apply?
  //
  // Not "is the text 'Easy Apply' anywhere on the page" — it is, constantly, in the
  // sidebar of similar jobs. Matching those made the run follow another posting's apply
  // link, land somewhere unrelated, get redirected, and report the job as expired.
  // Eight of ten LinkedIn jobs in one batch died that way, all of them scanned hours
  // earlier and perfectly alive.
  //
  // The apply link for this job points at /jobs/view/<this id>/apply, so require that.
  // What is this page actually offering?
  //
  // The old version answered one question — "is there an anchor whose href contains
  // /apply?" — and treated every other outcome as "this job applies on the company
  // site". That verdict was then written to the database permanently. Three separate
  // situations collapsed into it:
  //
  //   1. LinkedIn's DAILY EASY APPLY LIMIT. After enough applications in a day it stops
  //      opening the form and shows "You reached today's Easy Apply limit" instead.
  //      Every job looked external for the rest of the day, and each one was marked as
  //      such forever. On this account that is how 596 LinkedIn jobs — including ones
  //      the scan had positively identified as Easy Apply — came to be written off.
  //   2. A page variant where the control is an <a> whose href is the job URL itself,
  //      not /apply. It is a perfectly good Easy Apply job.
  //   3. A genuinely external job.
  //
  // So each is now recognised on its own terms, and anything unrecognised says so
  // rather than guessing. The control is identified by its TEXT being exactly "Easy
  // Apply" — the sidebar of similar jobs is full of cards that merely CONTAIN those
  // words, which is what the href test was really guarding against.
  const state = await safeEval(page, () => {
    const t = document.body.innerText || '';
    if (/reached today.{0,3}s easy apply limit|easy apply limit/i.test(t.slice(0, 4000))) return 'limit';
    if (/you('|’)?ve applied|application submitted/i.test(t.slice(0, 4000))) return 'already';

    const norm = (e) => (e.innerText || '').replace(/\s+/g, ' ').trim();
    const aria = (e) => (e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const controls = [...document.querySelectorAll('a, button')];

    const easy = controls.find((e) => /^easy apply$/i.test(norm(e)) || /^easy apply to /i.test(aria(e)));
    if (easy) return 'easy';

    // Positively external: a plain "Apply" control, which LinkedIn uses when the
    // application happens on the employer's own site.
    const ext = controls.find((e) => /^apply$/i.test(norm(e)) || /^apply to /i.test(aria(e)));
    if (ext) return 'external';

    return 'unknown';
  }, undefined, 'unknown');

  if (state === 'limit') {
    // Not this job's fault and not ours. Nothing is recorded against the posting.
    return { state: 'rate_limited', note: 'LinkedIn has paused Easy Apply for today — it will work again tomorrow' };
  }
  if (state === 'unknown') {
    return { state: 'unclear', note: 'Could not tell how this job is applied to — leaving it alone rather than guessing' };
  }
  if (state === 'already') return { state: 'already_applied', note: 'LinkedIn says you have already applied' };
  if (state === 'external') return { state: 'external', note: 'Not an Easy Apply job — applies on the company site' };

  // Open the flow. LinkedIn ships two variants and they need different handling.
  //
  //   A) the control is <a href=".../jobs/view/<id>/apply/?openSDUIApplyFlow=true">
  //      Following the href opens the form. Clicking it does nothing observable — the
  //      SPA swallows the event — which is why this used to navigate instead.
  //
  //   B) the control is <a href=".../jobs/view/<id>/"> — its own page.
  //      Here the href is useless and the /apply/ URL just redirects back. Only a real
  //      click opens anything, and it has to be a TRUSTED one: an in-page el.click()
  //      is ignored, a Playwright click works.
  //
  // And a click is also how LinkedIn tells you it has had enough for the day: the
  // "You reached today's Easy Apply limit" panel appears only after clicking, never on
  // load. That is why the limit went unnoticed and every job looked external.
  const control = await safeEval(page, () => {
    const norm = (e) => (e.innerText || '').replace(/\s+/g, ' ').trim();
    const aria = (e) => (e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const el = [...document.querySelectorAll('a, button')]
      .find((e) => /^easy apply$/i.test(norm(e)) || /^easy apply to /i.test(aria(e)));
    if (!el) return null;
    const href = el.getAttribute('href') || '';
    return { hasApplyHref: /\/apply/.test(href), href };
  }, undefined, null);

  if (control?.hasApplyHref) {
    const applyUrl = new URL(control.href, 'https://www.linkedin.com').toString();
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  } else {
    try {
      const loc = page.locator('a, button').filter({ hasText: /^Easy Apply$/ }).first();
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 15000 });
    } catch {
      return { state: 'error', note: 'The Easy Apply control would not open' };
    }
  }

  // Wait for whichever of the three things happened.
  let formOpen = false;
  let limited = false;
  for (let i = 0; i < 10 && !formOpen && !limited; i++) {
    await page.waitForTimeout(1200);
    const seen = await safeEval(page, () => ({
      dialog: document.querySelectorAll('div[role="dialog"] input, div[role="dialog"] select, div[role="dialog"] textarea').length > 0
        || document.querySelectorAll('div[role="dialog"]').length > 0,
      limit: /reached today.{0,3}s easy apply limit|easy apply limit/i.test(document.body.innerText.slice(0, 4000)),
    }), undefined, { dialog: false, limit: false });
    formOpen = seen.dialog;
    limited = seen.limit;
  }

  if (limited) {
    return { state: 'rate_limited', note: 'LinkedIn has paused Easy Apply for today — it will work again tomorrow' };
  }
  if (!formOpen) {
    const at = page.url();
    if (!/\/jobs\/view\//.test(at)) {
      return { state: 'expired', note: `Posting is gone — LinkedIn redirected to ${at.slice(0, 70)}` };
    }
    return { state: 'error', note: 'Easy Apply dialog did not open (LinkedIn may have changed the flow)' };
  }

  const missing = [];
  const unwritable = [];   // answers we have, but the widget would not accept
  // Keys we actually wrote a stored answer into during this run. Only these may have
  // that stored answer invalidated by a later validation error — see below.
  const attempted = new Set();
  let submitted = false;
  let lastShot = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    await page.waitForTimeout(1200);

    // Scan and fill REPEATEDLY within one step, not once.
    //
    // These forms are conditional: answering "do you have experience with X" makes the
    // follow-up "how many years of X" appear, and it appears only after the first
    // answer lands. A single scan therefore misses every second-order field — they were
    // not in the DOM when we looked. The step then refuses to advance and the only
    // evidence is a validation error on a field we never even saw, which is what made
    // this look like "the form rejects answers we have".
    const targets = [];
    const seenKeys = new Set();
    for (let pass = 0; pass < 4; pass++) {
      const scan = await scanFields(page, LI_DIALOG);
      const fresh = (scan?.unfilledTargets || []).filter((t) => !seenKeys.has(t.key));
      if (process.env.JOBFINDER_AUTOAPPLY_DEBUG === '1') {
        linfo(pid, `      · step ${step} pass ${pass}: ${(scan?.unfilledTargets || []).length} unfilled, ${(scan?.prefilled || []).length} prefilled, ${fresh.length} new`
          + (fresh.length ? ` → ${fresh.map((t) => t.label).join(' ; ').slice(0, 160)}` : ''));
      }
      if (!fresh.length) break;
      for (const t of fresh) { seenKeys.add(t.key); targets.push(t); }
      await fillTargets(fresh);
      await page.waitForTimeout(1100);   // let conditional fields render
    }

    async function fillTargets(list) {
    for (const t of list) {
      const r = await resolveAnswer(profile, t, exactMap, job);
      if (r.missing) {
        // Optional questions are not worth stopping an application for.
        if (!t.required) { linfo(pid, `      – skipped optional "${t.label}"`); continue; }
        missing.push({
          field_key: canonicalKey(t.key || t.label, t.type),
          label: r.reason === 'no-option-match'
            ? `${t.label} — your saved answer "${r.have}" is not one of the choices`
            // Name the problem: you cannot answer a salary question sensibly without
            // being told which currency it is in.
            : r.reason === 'currency-unknown'
              ? `${t.label} — which currency? ${r.detail}`
              : r.reason === 'identity-invalid'
                ? `${t.label} — ${r.detail}`
                : t.label,
          type: t.type,
          options: t.options,
          replace: r.reason === 'no-option-match',
        });
        continue;
      }
      const w = await fillAndVerify(page, t, r.value);
      if (w?.ok) {
        attempted.add(canonicalKey(t.key || t.label, t.type));
        linfo(pid, `      ✓ ${t.label} → ${String(r.value).slice(0, 40)}${r.derived ? `  (computed from ${r.derived})` : ''}`);
      } else if (t.required) {
        // We knew the answer but could not get it into the field. Treating that as
        // "done" is what made the wizard press Next forever.
        lwarn(pid, `      ⚠ ${t.label}: could not set "${String(r.value).slice(0, 30)}" (${w?.reason || 'unknown'})`);
        unwritable.push({ label: t.label, value: r.value, reason: w?.reason || 'unknown' });
      }
    }
    }

    if (missing.length) break;   // never advance a form we cannot complete

    const buttons = await dialogButtons(page, LI_DIALOG);
    const hasSubmit = buttons.some((b) => SUBMIT_RE.test(b.text) || SUBMIT_RE.test(b.aria));

    if (hasSubmit) {
      lastShot = await shoot(page, profile.id, job.id, 'final');
      if (!armed) {
        return { state: 'dry_run', note: 'Filled and ready to submit — stopped because auto-apply is not armed', shot: lastShot };
      }
      const ok = await clickByText(page, LI_DIALOG, SUBMIT_RE);
      if (!ok) return { state: 'error', note: 'Submit button vanished before it could be clicked', shot: lastShot };
      await page.waitForTimeout(4000);
      submitted = true;
      break;
    }

    const before = await stepSignature(page, LI_DIALOG);
    const advanced = await clickByText(page, LI_DIALOG, ADVANCE_RE);
    if (!advanced) {
      lastShot = await shoot(page, profile.id, job.id, `stuck-step${step}`);
      return { state: 'error', note: `No next/submit button at step ${step + 1} — buttons were: ${buttons.map((b) => b.text).join(' | ').slice(0, 120)}`, shot: lastShot };
    }
    await page.waitForTimeout(2000);

    // Did pressing Next actually do anything?
    //
    // If not, the form refused — and the only reason it refuses is a required answer
    // it does not have. LinkedIn frequently omits `required` and `aria-required` on
    // these custom widgets, so the field looked optional and got skipped. The refusal
    // IS the requirement signal, so anything still unanswered on this step gets parked
    // rather than skipped. Without this the wizard just presses Next twelve times and
    // reports nothing useful.
    if ((await stepSignature(page, LI_DIALOG)) === before) {
      for (const t of targets) {
        const r = await resolveAnswer(profile, t, exactMap, job);
        if (!r.missing) continue;
        const fk = canonicalKey(t.key || t.label, t.type);
        if (fk && !missing.some((m) => m.field_key === fk)) {
          missing.push({ field_key: fk, label: t.label, type: t.type, options: t.options });
        }
      }
      // Nothing was unanswered, so ask the form what it objects to.
      if (!missing.length) {
        const errs = await validationErrors(page, LI_DIALOG);
        for (const e of errs) {
          // Prefer the key the scan already used for this exact element.
          const scanned = e.token
            ? targets.find((t) => (t.selector || '').includes(`"${e.token}"`))
            : null;
          const fk = scanned
            ? canonicalKey(scanned.key || scanned.label, scanned.type)
            : canonicalKey(e.label, 'text');
          if (!fk || missing.some((m) => m.field_key === fk)) continue;
          missing.push({
            field_key: fk,
            label: e.value
              ? `${e.label} — the site rejected "${e.value}" (${e.error})`
              : `${e.label} (${e.error})`,
            type: e.options ? 'select' : 'text',
            options: e.options,
            // Only invalidate a stored answer we actually TRIED this run.
            //
            // A field flagged invalid that we never wrote to is simply an empty
            // required field — not evidence that your saved answer is wrong. Re-parking
            // it unconditionally flips an answered row back to needs_input, where
            // retrieval cannot see it, so the next run cannot answer it either and
            // parks it again. That loop makes a question permanently unanswerable: you
            // fill it in, and the run quietly undoes that every time.
            replace: attempted.has(fk),
          });
        }
      }
      if (!missing.length) {
        lastShot = await shoot(page, profile.id, job.id, `refused-step${step}`);
        const why = unwritable.length
          ? `could not set: ${unwritable.map((u) => `${u.label} (${u.reason})`).join(', ').slice(0, 140)}`
          : 'the form gave no reason and every field on it is answered';
        return { state: 'error', note: `The form would not advance past step ${step + 1} — ${why}`, shot: lastShot };
      }
      break;
    }
  }

  if (missing.length) {
    lastShot = await shoot(page, profile.id, job.id, 'blocked');
    return { state: 'needs_input', note: `${missing.length} question(s) I cannot answer`, missing, shot: lastShot };
  }
  if (!submitted) return { state: 'error', note: `Wizard did not reach a submit step in ${MAX_STEPS} steps`, shot: lastShot };

  const confirmed = await safeEval(page, () =>
    /application sent|your application was sent|application submitted/i.test(document.body.innerText.slice(0, 3000)),
  undefined, false);
  return {
    state: confirmed ? 'applied' : 'submit_clicked',
    note: confirmed
      ? 'Submitted - LinkedIn confirmed it was sent'
      : 'Submit was clicked, but LinkedIn confirmation was not observed. Quarantined for reconciliation.',
    shot: await shoot(page, profile.id, job.id, 'submitted'),
  };
}

// ── Naukri ──────────────────────────────────────────────────────────────────
//
// Naukri distinguishes the two apply types by button id, which is the cleanest signal
// either site gives us:
//     #apply-button         applies on Naukri  — what we can automate
//     #company-site-button  redirects to the employer — not ours to drive
//
// The danger here is that #apply-button has no review step. Clicking it sends the
// application, and for some jobs it then opens a chatbot that asks follow-up questions
// AFTER you are already in. So a dry run does not click it at all.
async function naukriApply(page, profile, job, { armed, exactMap, pid }) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  const kind = await safeEval(page, () => {
    // An expired listing does not 404 — Naukri quietly redirects to a SEARCH page for
    // similar roles. Every apply selector then misses, and the honest report is "this
    // job is gone", not "no apply button found", which reads like our bug.
    if (!/\/job-listings-/.test(location.href) || /\?expJD=|-jobs-in-/.test(location.href)) return 'expired';
    const t = document.body.innerText || '';
    if (/\binterest shared\b|\bshared interest\b/i.test(t.slice(0, 3000))) return 'already';
    if (/\bapplied\b/i.test(t.slice(0, 3000))) return 'already';
    if (document.querySelector('#apply-button')) return 'internal';
    if (document.querySelector('#company-site-button')) return 'external';
    // Early access role: the recruiter has not posted the job yet, so there is nothing
    // to apply to — "Share Interest" is the whole interaction.
    const share = [...document.querySelectorAll('button')]
      .find((b) => /share interest/i.test(b.innerText || '') && (b.offsetWidth || b.offsetHeight));
    if (share) return 'early';
    return 'none';
  }, undefined, 'none');

  if (kind === 'expired') return { state: 'expired', note: 'Listing is gone — Naukri redirected to search results' };

  // Early access: one click, no form, and irreversible in the same way an application
  // is — so a dry run stops here exactly as it does for a normal Naukri apply.
  if (kind === 'early') {
    if (!armed) {
      return {
        state: 'dry_run',
        note: 'Early access role — would share your interest with the recruiter (no form to fill)',
        shot: await shoot(page, profile.id, job.id, 'early-access'),
      };
    }
    const clicked = await safeEval(page, () => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /share interest/i.test(x.innerText || '') && (x.offsetWidth || x.offsetHeight));
      if (!b) return false;
      b.click();
      return true;
    }, undefined, false);
    if (!clicked) return { state: 'error', note: 'Share Interest button vanished before it could be clicked' };
    await page.waitForTimeout(3500);
    const ok = await safeEval(page, () =>
      /interest shared|shared interest|we have shared|thank you/i.test(document.body.innerText.slice(0, 3000)),
    undefined, false);
    return {
      state: 'applied',
      note: ok
        ? 'Early access role — interest shared with the recruiter'
        : 'Early access role — Share Interest clicked (no confirmation text seen)',
      shot: await shoot(page, profile.id, job.id, 'early-access-shared'),
    };
  }
  if (kind === 'already') return { state: 'already_applied', note: 'Naukri says you have already applied' };
  if (kind === 'external') return { state: 'external', note: 'Naukri "Apply on company site" — external redirect' };
  if (kind === 'none') return { state: 'error', note: 'No apply button found on the page' };

  if (!armed) {
    return {
      state: 'dry_run',
      note: 'Naukri applies the moment the button is clicked, so a dry run stops here',
      shot: await shoot(page, profile.id, job.id, 'before-apply'),
    };
  }

  const applyClicked = await page.click('#apply-button').then(() => true).catch(() => false);
  if (!applyClicked) return { state: 'error', note: 'Naukri Apply button click failed' };
  await page.waitForTimeout(4000);

  // Some jobs open a chatbot with extra questions once you are in.
  const chat = '.chatbot_DrawerContentWrapper, .chatbot_Drawer, [class*="chatbot"]';
  const missing = [];
  if (await page.$(chat)) {
    for (let step = 0; step < MAX_STEPS; step++) {
      await page.waitForTimeout(1500);
      const scan = await scanFields(page, chat);
      const targets = scan?.unfilledTargets || [];
      if (!targets.length) break;
      let wrote = false;
      for (const t of targets) {
        const r = await resolveAnswer(profile, t, exactMap, job);
        if (r.missing) {
          missing.push({ field_key: canonicalKey(t.key || t.label, t.type), label: t.label, type: t.type, options: t.options });
          continue;
        }
        const w = await setField(page, t, r.value);
        if (w?.ok) { wrote = true; linfo(pid, `      ✓ ${t.label} → ${String(r.value).slice(0, 40)}`); }
      }
      if (missing.length) break;
      if (!wrote) break;
      await clickByText(page, chat, /^(save|next|submit|continue)$/i);
    }
  }

  const shot = await shoot(page, profile.id, job.id, 'after-apply');
  if (missing.length) {
    // The application is already in — Naukri sent it on click. Say so plainly rather
    // than implying it was held back.
    return { state: 'applied_incomplete', note: `Applied, but the follow-up chatbot asked ${missing.length} question(s) I could not answer`, missing, shot };
  }
  const ok = await safeEval(page, () => /applied|application sent/i.test(document.body.innerText.slice(0, 3000)), undefined, false);
  return {
    state: ok ? 'applied' : 'submit_clicked',
    note: ok
      ? 'Applied on Naukri - confirmation observed'
      : 'Apply was clicked, but Naukri confirmation was not observed. Quarantined for reconciliation.',
    shot,
  };
}

/** Apply to one job. Never throws — a bad job must not stop the run. */
export async function autoApplyJob(ctx, profile, job, { armed = false } = {}) {
  const pid = profile.id;
  const page = await ctx.newPage();
  try {
    const exactMap = await answersAsMap(pid);
    const fn = job.connector === 'linkedin' ? linkedinApply
      : job.connector === 'naukri' ? naukriApply
        : null;
    if (!fn) return { state: 'unsupported', note: `${job.connector} has no on-site apply flow` };
    return await fn(page, profile, job, { armed, exactMap, pid });
  } catch (e) {
    return { state: 'error', note: String(e?.message || e).slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

// How stale a posting may be before trying it is a waste of time.
//
// This is the single biggest efficiency lever, and getting it wrong is what made the
// first runs useless. Ordering by fit_score alone put a high-scoring 87-day-old Naukri
// listing ahead of a job scanned this morning — and a Naukri listing that old is
// always gone. Measured on a real 10-job batch ordered that way: 8 expired, 1 already
// applied, 1 external, 0 actually applied. The whole budget went on dead postings.
//
// Naukri's window used to be 10 days, on the theory that older listings are dead and
// trying them wastes the batch. Two later changes made that caution unnecessary: an
// expired Naukri listing is now recognised in a couple of seconds (it redirects to a
// search page) and permanently marked, and a skip no longer consumes one of the batch's
// places. So the only cost of looking further back is a few seconds once per posting,
// and the benefit is real — 36 untried postings on this profile sat just outside the old
// window while the board reported "nothing to do".
const MAX_AGE_DAYS = { naukri: 21, linkedin: 21 };

// ── Where the jobs in a batch come from ──────────────────────────────────────
//
// A batch drawn purely by freshness ends up wherever the boards happened to be busy
// that morning, which is usually all one place. The mix is set deliberately instead.
//
// TARGET MIX per batch: half at home, a third worldwide, a fifth remote.
// PRIORITY when a bucket cannot be filled: remote first, then home, then worldwide.
//
// The two are not in conflict, they answer different questions. The mix decides how a
// full batch is composed; the priority decides who inherits the places a thin bucket
// could not use. Naukri, for instance, is almost entirely domestic — its worldwide
// bucket is nearly always short, and those places go to remote roles before local ones.
const LOCATION_MIX = { home: 0.5, worldwide: 0.3, remote: 0.2 };
const BACKFILL_ORDER = ['remote', 'home', 'worldwide'];

const REMOTE_RE = /\bremote\b|work from home|\bwfh\b|anywhere|distributed team/i;

/**
 * Which bucket a posting belongs to.
 *
 * Remote wins over geography on purpose: "Bengaluru (Remote)" is a remote job that
 * happens to name a city, and treating it as domestic would let the home bucket
 * swallow the remote quota.
 */
export function locationBucket(job, homeCountry = 'india') {
  const text = `${job.location || ''} ${job.title || ''}`;
  if (REMOTE_RE.test(text)) return 'remote';
  const loc = String(job.location || '').toLowerCase();
  if (!loc) return 'home';          // unlabelled: assume the board's own market
  if (loc.includes(homeCountry)) return 'home';
  // Boards routinely give a bare city for domestic roles and add the country only for
  // foreign ones, so a known home city counts as home even with no country named.
  if (HOME_CITIES.some((c) => loc.includes(c))) return 'home';
  return 'worldwide';
}

const HOME_CITIES = [
  'bengaluru', 'bangalore', 'mumbai', 'delhi', 'noida', 'gurgaon', 'gurugram',
  'hyderabad', 'chennai', 'pune', 'kolkata', 'ahmedabad', 'jaipur', 'indore',
  'chandigarh', 'coimbatore', 'kochi', 'trivandrum', 'bhubaneswar', 'nagpur',
];

/**
 * Choose `limit` postings with the target mix, in priority order.
 *
 * Everything arrives already sorted (freshest first), and that order is preserved
 * inside each bucket — the mix decides how many come from where, never which ones.
 */
export function pickByLocationMix(rows, limit, mix = LOCATION_MIX) {
  if (limit <= 0 || !rows.length) return [];

  const buckets = { home: [], worldwide: [], remote: [] };
  for (const r of rows) buckets[locationBucket(r)].push(r);

  // Quotas, largest remainder first so the total always adds up to `limit` exactly
  // rather than drifting a job short or long on odd numbers.
  const raw = Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, limit * v]));
  const quota = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.floor(v)]));
  let spare = limit - Object.values(quota).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(raw).sort((a, b) => (raw[b] % 1) - (raw[a] % 1))) {
    if (spare <= 0) break;
    quota[k]++; spare--;
  }

  const picked = [];
  const taken = { home: 0, worldwide: 0, remote: 0 };
  for (const k of BACKFILL_ORDER) {
    const n = Math.min(quota[k] || 0, buckets[k].length);
    picked.push(...buckets[k].slice(0, n));
    taken[k] = n;
  }

  // Places no bucket could use go to whoever has candidates left, in priority order.
  let short = limit - picked.length;
  for (const k of BACKFILL_ORDER) {
    if (short <= 0) break;
    const extra = buckets[k].slice(taken[k], taken[k] + short);
    picked.push(...extra);
    taken[k] += extra.length;
    short -= extra.length;
  }
  return picked;
}

/**
 * Jobs worth trying, for ONE connector, freshest first.
 *
 * Per-connector because the two are applied to in parallel, and because a shared
 * ordering lets whichever board happens to have more rows crowd the other out.
 *
 * Ordering is by AGE IN WHOLE DAYS first, then fit within the same day. Sorting by fit
 * across the whole window has the same failure in miniature: fresh postings usually
 * have no fit score yet (scoring runs later), so they sort as 0 and land behind
 * three-week-old scored ones. Day-bucketing means today's jobs always go first, and
 * fit only decides the order among equally fresh ones.
 */
export async function eligibleJobs(profileId, limit, { connector, maxAgeDays, jobIds } = {}) {
  const days = maxAgeDays ?? (connector ? MAX_AGE_DAYS[connector] : 21) ?? 21;
  const cutoff = Date.now() - days * 86400000;
  const conns = connector ? [connector] : ['linkedin', 'naukri'];
  const placeholders = conns.map(() => '?').join(',');
  const exactIds = Array.isArray(jobIds) && jobIds.length ? jobIds : null;
  const idClause = exactIds ? `AND id IN (${exactIds.map(() => '?').join(',')})` : '';

  const rows = await all(
    `SELECT * FROM jobs
      WHERE profile_id = ?
        AND connector IN (${placeholders})
        ${idClause}
        AND status IN ('new','shortlisted','in_progress')
        AND (auto_apply_state IS NULL
             OR auto_apply_state IN ('dry_run','needs_input','error'))
        -- Known to redirect to the employer's own site. Nothing here can drive those,
        -- and on Naukri this is known at scan time, so they never cost a slot.
        AND COALESCE(apply_kind, '') <> 'external'
        -- Tried and failed repeatedly. Set aside so one broken form cannot occupy a
        -- place in every future batch.
        AND COALESCE(auto_apply_attempts, 0) < ?
        AND COALESCE(discovered_at, 0) >= ?
      ORDER BY (? - COALESCE(discovered_at, 0)) / 86400000 ASC,
               COALESCE(fit_score, 0) DESC,
               discovered_at DESC
      LIMIT ?`,
    [profileId, ...conns, ...(exactIds || []), MAX_ATTEMPTS, cutoff, Date.now(), limit * 6]
  );

  // Jobs parked on a question you have not answered yet are not worth reopening: the
  // run would walk the same wizard, hit the same blank field and park it again, having
  // spent a slot to learn nothing. They come back automatically the moment the question
  // is answered, which is the whole point of keying questions by field_key.
  const stillWaiting = new Set(
    (await all(
      "SELECT field_key FROM answers WHERE profile_id = ? AND status = 'needs_input'",
      [profileId]
    )).map((r) => r.field_key)
  );

  const ready = rows.filter((j) => {
    if (j.auto_apply_state !== 'needs_input') return true;
    let blocked = [];
    try { blocked = JSON.parse(j.auto_apply_blocked_on || '[]'); } catch { blocked = []; }
    if (!blocked.length) return true;                    // unknown — let it try again
    return !blocked.some((k) => stillWaiting.has(k));    // every question answered
  });

  // When the orchestrator supplies exact IDs, its order is authoritative. Do not
  // re-mix those rows by geography or fit score, because that would make the Sheet
  // claim one queue order while the browser actually processes another.
  if (exactIds) {
    const rank = new Map(exactIds.map((id, i) => [id, i]));
    return ready
      .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
      .slice(0, limit);
  }

  // Compose ordinary autonomous batches deliberately rather than taking the first
  // `limit` by date.
  return pickByLocationMix(ready, limit);
}

/** What auto-apply would work through right now, split by board. */
export async function eligibleByConnector(profileId, limit = 25, { jobIds } = {}) {
  const out = {};
  for (const c of ['linkedin', 'naukri']) {
    out[c] = await eligibleJobs(profileId, limit, { connector: c, jobIds });
  }
  return out;
}

/**
 * Run a batch.
 *
 * The cap is not a formality. Both sites rate-limit applications and both treat a
 * burst as automation; losing the logged-in session costs far more than the extra
 * applications are worth, because everything else in JobFinder depends on it.
 */
export async function autoApplyRun(profile, { armed = false, limit = 10, perSite, jobIds } = {}) {
  const pid = profile.id;
  // Ask for far more candidates than the target. Most of the surplus will be skipped in
  // seconds (external, expired), and the pool needs enough depth for the board to still
  // reach `limit` genuine attempts.
  const pools = await eligibleByConnector(pid, limit * 6, { jobIds });
  const summary = {
    armed,
    target: limit,
    candidates: Object.fromEntries(Object.entries(pools).map(([c, r]) => [c, r.length])),
    applied: 0, unconfirmed: 0, dryRun: 0, needsInput: 0, skipped: 0, errors: 0, abandoned: 0, deferred: 0,
    parked: [], results: [],
  };

  if (!Object.values(pools).some((r) => r.length)) {
    lwarn(pid, '  Nothing eligible — scan first. Postings older than their freshness window are skipped because they have almost always expired.');
    return summary;
  }

  const ctx = await getContext(pid, 'autoapply', { headless: true, stealth: true, offscreen: true });

  // Record one job's outcome. Shared by both pools, so it must not assume it is alone:
  // every mutation is keyed by job id and every counter is incremented, never assigned.
  // Outcomes that mean "we actually got to work on this posting". Everything else —
  // external, expired, already applied — was decided in a few seconds without opening a
  // form, and must NOT consume one of the batch's places. That distinction is what makes
  // a run of 10 mean 10 real attempts instead of 10 lookups.
  const USABLE = new Set(['applied', 'submit_clicked', 'dry_run', 'needs_input', 'applied_incomplete', 'error']);
  // Outcomes worth counting against a posting's retry budget.
  //
  // 'needs_input' is deliberately NOT here. A job waiting on a question you have not
  // answered yet has not failed at anything — it is waiting on you, and it should wait
  // for as long as that takes. Counting it as a failure threw away two perfectly good
  // applications after three passes, purely because nobody had typed an answer.
  const FAILED = new Set(['error']);

  async function record(job, r) {
    // The site refused us rather than the posting being unusable. Leave the job exactly
    // as it was — unrecorded, uncounted, still eligible — so the next run picks it up.
    if (r.state === 'error' && isTransient(r.note)) {
      summary.deferred = (summary.deferred || 0) + 1;
      lwarn(pid, `    ↻ ${job.connector}: ${(job.title || '').slice(0, 40)} — ${String(r.note).slice(0, 60)} (will retry, not counted)`);
      return false;
    }

    // The board is refusing everyone, or the page did not say what it was. Neither is a
    // fact about this posting, so nothing is written down. Recording either as
    // "external" is what wrote off hundreds of perfectly good jobs during a day when
    // LinkedIn had simply had enough.
    if (r.state === 'rate_limited' || r.state === 'unclear') {
      summary.deferred = (summary.deferred || 0) + 1;
      return false;
    }

    for (const q of r.missing || []) {
      const parked = await parkQuestion(pid, { ...q, jobId: job.id });
      if (parked.parked) summary.parked.push(q.label);
    }

    // Record what the job is ACTUALLY waiting on — the questions that reached your
    // panel — not everything we reported as missing.
    //
    // Those are different sets, and the gap between them cost real applications. The
    // validation path reports any field the form flags, including ones you have already
    // answered; parkQuestion rightly refuses to re-ask those, so the job ended up
    // "blocked" on a key that was not waiting for anything. Eligibility then judged it
    // answerable, retried it every run, and threw it out after three.
    //
    // If nothing is genuinely waiting, the job is not blocked on you: the form is
    // rejecting something we cannot fix, which is an error and should be named as one.
    let blockedOn = [];
    if ((r.missing || []).length) {
      const waiting = new Set(
        (await all("SELECT field_key FROM answers WHERE profile_id = ? AND status = 'needs_input'", [pid]))
          .map((x) => x.field_key)
      );
      blockedOn = (r.missing || []).map((q) => q.field_key).filter((k) => k && waiting.has(k));
    }
    if ((r.state === 'needs_input' || r.state === 'applied_incomplete') && !blockedOn.length && (r.missing || []).length) {
      r = {
        ...r,
        state: r.state === 'applied_incomplete' ? r.state : 'error',
        note: `The form rejected ${(r.missing || []).length} field(s) that your answer bank already answers — `
          + `${(r.missing || []).map((q) => q.field_key).join(', ').slice(0, 90)}`,
      };
    }

    const attempts = (job.auto_apply_attempts || 0) + (USABLE.has(r.state) ? 1 : 0);
    // Out of retries and still not through: set it aside permanently.
    //
    // Per POSTING, never per role. A reposted opening is a different row with its own
    // external_id and its own counter, so giving up on today's broken form does not
    // stop you applying when the same employer posts it again next month.
    let state = r.state;
    let note = r.note || '';
    if (FAILED.has(r.state) && attempts >= MAX_ATTEMPTS) {
      state = 'abandoned';
      note = `Gave up after ${attempts} attempts — ${note}`.slice(0, 300);
    }

    await run(
      `UPDATE jobs SET auto_apply_state = ?, auto_apply_note = ?, auto_applied_at = ?,
                      auto_apply_attempts = ?, auto_apply_blocked_on = ?, apply_kind = COALESCE(?, apply_kind)
        WHERE id = ?`,
      [
        state, note, r.state === 'applied' ? Date.now() : null,
        attempts, blockedOn.length ? JSON.stringify(blockedOn) : null,
        // Learn the apply type from what we just saw — but never DOWNGRADE what the
        // scan already established. The scan reads Easy Apply feeds and Naukri's own
        // API, which say so authoritatively; a run-time look at one page is a weaker
        // signal and was overwriting them.
        r.state === 'external' && job.apply_kind !== 'internal' ? 'external'
          : (USABLE.has(r.state) ? 'internal' : null),
        job.id,
      ]
    );
    if (state === 'abandoned') {
      summary.abandoned = (summary.abandoned || 0) + 1;
      lwarn(pid, `    ⊘ ${job.connector}: ${note}`);
      summary.results.push({ job_id: job.id, title: job.title, company: job.company, connector: job.connector, ...r, state });
      return USABLE.has(r.state);
    }
    if (r.state === 'applied') {
      await run("UPDATE jobs SET status = 'applied', status_changed_at = ? WHERE id = ?", [Date.now(), job.id]);
      summary.applied++;
      lok(pid, `    ✅ ${job.connector}: ${r.note}`);
    } else if (r.state === 'submit_clicked') {
      summary.unconfirmed++;
      lwarn(pid, `    ? ${job.connector}: ${r.note}`);
    } else if (r.state === 'dry_run') {
      summary.dryRun++;
      lok(pid, `    🧪 ${job.connector}: ${r.note}`);
    } else if (r.state === 'needs_input' || r.state === 'applied_incomplete') {
      summary.needsInput++;
      lwarn(pid, `    ⏸ ${job.connector}: ${r.note}`);
    } else if (r.state === 'error') {
      summary.errors++;
      lerr(pid, `    ✗ ${job.connector}: ${r.note}`);
    } else {
      summary.skipped++;
      linfo(pid, `    – ${job.connector}: ${r.note}`);
    }
    summary.results.push({ job_id: job.id, title: job.title, company: job.company, connector: job.connector, ...r });
    return USABLE.has(r.state);
  }

  /**
   * One board's queue.
   *
   * WITHIN a board the work is paced and mostly serial; ACROSS boards it runs at the
   * same time. That split is the whole design:
   *
   *   • LinkedIn and Naukri are unrelated servers with unrelated rate limits, so doing
   *     both at once is free speed — the run takes as long as the slower board rather
   *     than the sum of the two.
   *   • Firing ten applications at the SAME board simultaneously is not free. It is the
   *     clearest automation signal either site gets, and the penalty is a restricted
   *     account, which costs the logged-in session everything else here depends on.
   *
   * So a live run stays one-at-a-time per board with a human gap between submissions. A
   * dry run submits nothing, so it opens a few tabs at once purely to get through the
   * survey faster.
   */
  async function runPool(connector, jobs) {
    if (!jobs.length) return;
    const width = armed ? 1 : Math.min(perSite || DRY_WIDTH[connector] || 2, 4);
    linfo(pid, `  ▸ ${connector}: aiming for ${limit} real attempt(s) from ${jobs.length} candidate(s), ${width} at a time`);

    let next = 0;
    let usable = 0;      // postings we actually got to work on
    let looked = 0;      // postings opened at all, including instant skips
    // Places taken by work in progress. Without this, every worker sees `usable < limit`
    // at the same moment and they all start one more, so a limit of 10 quietly becomes
    // 12. Reserving the place up front and giving it back when the posting turns out to
    // be a skip keeps the number you asked for the number you get.
    let claimed = 0;

    const workers = Array.from({ length: Math.min(width, jobs.length) }, async () => {
      // Keep pulling candidates until the board has produced `limit` REAL attempts.
      //
      // The old loop consumed one candidate per slot, so a batch of ten could finish
      // having applied to nothing — every place taken by a posting that turned out to
      // redirect to the employer, or to have expired. Those cost a few seconds and
      // teach us something permanent (apply_kind is recorded), so they should not count
      // against the batch.
      while (claimed < limit && next < jobs.length) {
        const job = jobs[next++];
        claimed++;
        looked++;
        linfo(pid, `    · ${connector}: ${(job.title || job.id).slice(0, 60)} @ ${job.company || ''}`);
        let r;
        try {
          r = await autoApplyJob(ctx, profile, job, { armed });
        } catch (e) {
          r = { state: 'error', note: String(e?.message || e).slice(0, 160) };
        }
        // The board has cut us off for the day. Finishing the queue would just repeat
        // the same refusal on every remaining posting.
        if (r.state === 'rate_limited') {
          lwarn(pid, `  ⏸ ${connector}: ${r.note}. Stopping this board for now.`);
          summary.rateLimited = summary.rateLimited || [];
          if (!summary.rateLimited.includes(connector)) summary.rateLimited.push(connector);
          await record(job, r);
          next = jobs.length;      // drain the queue for every worker
          break;
        }
        if (await record(job, r)) usable++;
        else claimed--;   // not a real attempt — hand the place back
        if (armed && r.state === 'applied') {
          await new Promise((res) => setTimeout(res, 12000 + Math.random() * 18000));
        }
      }
    });
    await Promise.all(workers);
    summary.byBoard = summary.byBoard || {};
    summary.byBoard[connector] = { attempts: usable, opened: looked, candidates: jobs.length };
    linfo(pid, `  ▸ ${connector}: ${usable} real attempt(s) from ${looked} posting(s) opened`);
  }

  const started = Date.now();
  // Promise.all, not sequential: this is the parallelism.
  await Promise.all(Object.entries(pools).map(([c, jobs]) => runPool(c, jobs)));
  summary.tookSeconds = Math.round((Date.now() - started) / 1000);

  if (summary.parked.length) {
    lwarn(pid, `  ❓ ${summary.parked.length} question(s) need your answer before those jobs can go out.`);
  }
  return summary;
}

