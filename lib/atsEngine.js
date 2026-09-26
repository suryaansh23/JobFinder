import fs from 'node:fs';
import path from 'node:path';
import { getContext } from './browser.js';
import { autofillContext } from './autofill.js';
import { parkQuestion, canonicalKey } from './answerBank.js';
import { dataPath } from './paths.js';

const MAX_STEPS = 10;
const NEXT_RE = /^(next|continue|save and continue|review|review application|continue application)$/i;
const SUBMIT_RE = /^(submit|submit application|send application|apply now|finish)$/i;

export function detectAtsProvider(url = '') {
  const u = String(url).toLowerCase();
  if (/greenhouse\.io|boards\.greenhouse\.io|job-boards\.greenhouse\.io/.test(u)) return 'greenhouse';
  if (/lever\.co|jobs\.lever\.co/.test(u)) return 'lever';
  if (/myworkdayjobs\.com|workdayjobs\.com|wd\d+\.myworkdayjobs/.test(u)) return 'workday';
  if (/smartrecruiters\.com/.test(u)) return 'smartrecruiters';
  if (/icims\.com/.test(u)) return 'icims';
  return 'generic';
}

function applicationDir(profileId) {
  const dir = dataPath('applications', profileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function screenshot(page, profileId, jobId, tag) {
  try {
    const file = path.join(applicationDir(profileId), `${jobId}-ats-${tag}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

async function visibleText(frame, max = 8000) {
  try {
    return await frame.evaluate((m) => String(document.body?.innerText || '').slice(0, m), max);
  } catch { return ''; }
}

async function detectChallenge(page) {
  for (const frame of page.frames()) {
    const url = String(frame.url() || '').toLowerCase();
    if (/recaptcha|hcaptcha|challenges\.cloudflare|turnstile/.test(url)) {
      return { kind: 'captcha', note: 'CAPTCHA or anti-bot challenge detected.' };
    }
    try {
      const state = await frame.evaluate(() => {
        const text = String(document.body?.innerText || '').slice(0, 6000);
        const hasCaptcha = !!document.querySelector(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="captcha" i], [id*="captcha" i], [data-sitekey]'
        ) || /verify you are human|security check|checking your browser|captcha/i.test(text);
        if (hasCaptcha) return { kind: 'captcha', note: 'Human verification is required.' };

        const otp = !!document.querySelector(
          'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i]'
        ) || /one[- ]time (?:password|code)|verification code|enter the code (?:sent|we sent)/i.test(text);
        if (otp) return { kind: 'otp', note: 'A one-time verification code is required.' };

        const login = !!document.querySelector('input[type="password"]')
          && /sign in|log in|login|password/i.test(text.slice(0, 2500));
        if (login) return { kind: 'login_required', note: 'ATS login is required.' };
        return null;
      });
      if (state) return state;
    } catch { /* frame changed while checking */ }
  }
  return null;
}

async function formSignal(page) {
  let count = 0;
  for (const frame of page.frames()) {
    try {
      count += await frame.locator('input:not([type="hidden"]), textarea, select, input[type="file"]').count();
    } catch { /* ignore */ }
  }
  return count;
}

async function clickKnownEntry(page, provider) {
  if (provider === 'generic') return false;
  const selectors = {
    greenhouse: ['a[href*="#app"]', 'a[href*="application"]', 'button:has-text("Apply")'],
    lever: ['a.postings-btn', 'a:has-text("Apply for this job")', 'a:has-text("Apply")'],
    workday: ['a:has-text("Apply")', 'button:has-text("Apply")', '[data-automation-id="jobPostingApplyButton"]'],
    smartrecruiters: ['a:has-text("Apply")', 'button:has-text("Apply")'],
    icims: ['a:has-text("Apply")', 'button:has-text("Apply")'],
  }[provider] || [];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible().catch(() => false)) {
        await Promise.all([
          loc.click({ timeout: 8000 }),
          page.waitForTimeout(1200),
        ]);
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function ensureApplicationForm(page, provider) {
  if (await formSignal(page) >= 3) return { ok: true };
  if (provider === 'generic') {
    return { ok: false, human: true, note: 'Generic career page has no clear application form. Entry click requires review.' };
  }
  const clicked = await clickKnownEntry(page, provider);
  if (!clicked) return { ok: false, human: true, note: `Could not identify a safe ${provider} application-entry control.` };
  await page.waitForTimeout(1800);
  if (await formSignal(page) >= 2) return { ok: true };
  const challenge = await detectChallenge(page);
  if (challenge) return { ok: false, human: true, challenge };
  return { ok: false, human: true, note: `Entered ${provider}, but no supported form was detected.` };
}

async function requiredEmptyFields(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const rows = await frame.evaluate(() => {
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const labelFor = (el) => {
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.trim();
          if (el.id) {
            const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (l?.innerText?.trim()) return l.innerText.trim();
          }
          const parent = el.closest('label');
          if (parent?.innerText?.trim()) return parent.innerText.trim().slice(0, 180);
          const nearby = el.parentElement?.innerText?.trim();
          return nearby ? nearby.slice(0, 180) : (el.name || el.id || 'Required field');
        };
        const fields = [...document.querySelectorAll('input, textarea, select')];
        return fields.filter((el) => {
          if (!visible(el) || el.disabled || el.type === 'hidden') return false;
          const req = el.required || el.getAttribute('aria-required') === 'true';
          if (!req) return false;
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (!el.name) return !el.checked;
            return !document.querySelector(`input[name="${CSS.escape(el.name)}"]:checked`);
          }
          return !String(el.value || '').trim();
        }).map((el) => ({
          label: labelFor(el),
          type: el.tagName === 'SELECT' ? 'select' : (el.type || el.tagName.toLowerCase()),
          options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.text.trim()).filter(Boolean) : null,
        }));
      });
      for (const row of rows || []) out.push(row);
    } catch { /* frame may be navigating */ }
  }
  return out;
}

async function validationMessages(page) {
  const messages = [];
  for (const frame of page.frames()) {
    try {
      const m = await frame.evaluate(() => [...document.querySelectorAll(
        '[role="alert"], [aria-live="assertive"], [class*="error" i], [data-automation-id*="error" i]'
      )].filter((el) => el.offsetWidth || el.offsetHeight).map((el) => String(el.innerText || '').trim())
        .filter((x) => x && x.length < 500).slice(0, 20));
      messages.push(...m);
    } catch { /* ignore */ }
  }
  return [...new Set(messages)].slice(0, 20);
}

async function buttonInventory(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const rows = await frame.evaluate(() => [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
        .filter((el) => el.offsetWidth || el.offsetHeight)
        .map((el) => ({
          text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          disabled: !!el.disabled,
        })).filter((x) => x.text).slice(0, 80));
      out.push(...rows);
    } catch { /* ignore */ }
  }
  return out;
}

async function clickButtonByExactText(page, regex) {
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate((source) => {
        const re = new RegExp(source, 'i');
        const els = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')];
        const el = els.find((x) => {
          const t = String(x.innerText || x.value || x.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          return (x.offsetWidth || x.offsetHeight) && !x.disabled && re.test(t);
        });
        if (!el) return false;
        el.click();
        return true;
      }, regex.source);
      if (clicked) return true;
    } catch { /* ignore */ }
  }
  return false;
}

async function confirmation(page) {
  const url = String(page.url() || '');
  if (/thank|confirmation|submitted|application-success/i.test(url)) return true;
  for (const frame of page.frames()) {
    const text = await visibleText(frame, 7000);
    if (/thank you for applying|application (?:has been )?(?:submitted|received)|we received your application|application successfully submitted|thanks for applying/i.test(text)) {
      return true;
    }
  }
  return false;
}

async function parkMissing(profile, job, missing) {
  const parked = [];
  for (const item of missing) {
    const key = canonicalKey(item.label, item.type);
    if (!key) continue;
    const r = await parkQuestion(profile.id, {
      field_key: key,
      label: item.label,
      type: item.type,
      options: item.options,
      jobId: job.id,
    });
    if (r?.parked) parked.push({ ...item, field_key: key });
  }
  return parked;
}

export async function applyAtsJob(ctx, profile, job, { armed = false } = {}) {
  const page = await ctx.newPage();
  const provider = detectAtsProvider(job.url);
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    await page.bringToFront().catch(() => {});

    let challenge = await detectChallenge(page);
    if (challenge) return { state: 'human_required', provider, ...challenge, shot: await screenshot(page, profile.id, job.id, 'challenge') };

    const entry = await ensureApplicationForm(page, provider);
    if (!entry.ok) {
      const ch = entry.challenge || {};
      return {
        state: 'human_required', provider, kind: ch.kind || 'navigation',
        note: ch.note || entry.note || 'Human review required before entering this ATS form.',
        shot: await screenshot(page, profile.id, job.id, 'entry'),
      };
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      await page.bringToFront().catch(() => {});
      challenge = await detectChallenge(page);
      if (challenge) return { state: 'human_required', provider, ...challenge, shot: await screenshot(page, profile.id, job.id, `challenge-${step}`) };

      const fill = await autofillContext(ctx, profile, job, { mode: 'llm-fallback', overwrite: false, allPages: false });
      await page.waitForTimeout(700);

      const missing = await requiredEmptyFields(page);
      if (missing.length) {
        const parked = await parkMissing(profile, job, missing);
        return {
          state: 'needs_input', provider,
          note: `${missing.length} required ATS field(s) are still empty.`,
          missing: parked.length ? parked : missing,
          fill, shot: await screenshot(page, profile.id, job.id, `missing-${step}`),
        };
      }

      const buttons = await buttonInventory(page);
      const submit = buttons.find((b) => SUBMIT_RE.test(b.text));
      if (submit) {
        const shot = await screenshot(page, profile.id, job.id, 'ready');
        if (!armed) {
          return { state: 'ats_ready', provider, note: `ATS form filled and ready to submit on ${provider}.`, fill, shot };
        }

        const clicked = await clickButtonByExactText(page, SUBMIT_RE);
        if (!clicked) return { state: 'error', provider, note: 'Final submit control disappeared before click.', shot };
        await page.waitForTimeout(3500);

        challenge = await detectChallenge(page);
        if (challenge) {
          return {
            state: 'human_required', provider, ...challenge, submittedMayHaveStarted: true,
            note: `${challenge.note} This appeared after the final submit action; reconcile before retrying.`,
            shot: await screenshot(page, profile.id, job.id, 'post-submit-challenge'),
          };
        }
        if (await confirmation(page)) {
          return { state: 'applied', provider, note: `Application confirmed by ${provider}.`, shot: await screenshot(page, profile.id, job.id, 'confirmed') };
        }
        return {
          state: 'submit_clicked', provider,
          note: `Submit was clicked on ${provider}, but no confirmation was observed.`,
          shot: await screenshot(page, profile.id, job.id, 'unconfirmed'),
        };
      }

      const next = buttons.find((b) => NEXT_RE.test(b.text));
      if (!next) {
        const errors = await validationMessages(page);
        return {
          state: 'human_required', provider, kind: 'unsupported_form',
          note: errors.length ? `ATS stopped with: ${errors.join(' | ').slice(0, 500)}` : 'ATS form has no supported Next or Submit control.',
          fill, errors, shot: await screenshot(page, profile.id, job.id, `stuck-${step}`),
        };
      }

      const beforeUrl = page.url();
      const clicked = await clickButtonByExactText(page, NEXT_RE);
      if (!clicked) return { state: 'error', provider, note: `Could not activate the ${next.text} control.` };
      await page.waitForTimeout(1800);

      const errors = await validationMessages(page);
      if (errors.length && page.url() === beforeUrl) {
        const moreMissing = await requiredEmptyFields(page);
        if (moreMissing.length) {
          const parked = await parkMissing(profile, job, moreMissing);
          return { state: 'needs_input', provider, note: errors.join(' | ').slice(0, 500), missing: parked.length ? parked : moreMissing };
        }
        return { state: 'human_required', provider, kind: 'validation', note: errors.join(' | ').slice(0, 500), errors };
      }
    }

    return { state: 'human_required', provider, kind: 'too_many_steps', note: `ATS did not reach a final submit step within ${MAX_STEPS} steps.` };
  } catch (e) {
    return { state: 'error', provider, note: String(e?.message || e).slice(0, 500), shot: await screenshot(page, profile.id, job.id, 'error') };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function runAtsBatch(profile, jobs, { armed = false } = {}) {
  const summary = { armed, attempted: 0, applied: 0, ready: 0, actionRequired: 0, errors: 0, results: [] };
  if (!jobs.length) return summary;
  const ctx = await getContext(profile.id, 'ats', { headless: true, stealth: true, offscreen: true });
  for (const job of jobs) {
    const result = await applyAtsJob(ctx, profile, job, { armed });
    summary.attempted++;
    if (result.state === 'applied') summary.applied++;
    else if (result.state === 'ats_ready') summary.ready++;
    else if (['human_required', 'needs_input', 'submit_clicked'].includes(result.state)) summary.actionRequired++;
    else if (result.state === 'error') summary.errors++;
    summary.results.push({ job_id: job.id, title: job.title, company: job.company, ...result });
    if (armed && result.state === 'applied') {
      await new Promise((resolve) => setTimeout(resolve, 12000 + Math.random() * 18000));
    }
  }
  return summary;
}
