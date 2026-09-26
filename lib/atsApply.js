import { getContext } from './browser.js';
import { autofillContext } from './autofill.js';
import { detectAts } from './atsDetector.js';
import { canonicalKey, parkQuestion } from './answerBank.js';
import { dataPath } from './paths.js';
import fs from 'node:fs';
import path from 'node:path';

const PROVIDERS = new Set(['greenhouse', 'lever']);

const APPLY_TEXT = /^(apply|apply now|apply for this job|submit application)$/i;
const SUBMIT_TEXT = /^(submit application|submit|apply|send application)$/i;
const CONFIRM_RE = /thank you for applying|application (has been )?(submitted|received)|we have received your application|your application was sent/i;
const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|verify you are human|security check/i;

function shotDir(profileId) {
  const dir = dataPath('applications', profileId, 'ats');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function screenshot(page, profileId, jobId, tag) {
  try {
    const file = path.join(shotDir(profileId), `${jobId}-${tag}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

async function visibleText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 5000 });
  } catch {
    return '';
  }
}

async function hasCaptcha(page) {
  try {
    const frames = page.frames();
    for (const frame of frames) {
      const url = String(frame.url() || '');
      if (/recaptcha|hcaptcha|captcha/i.test(url)) return true;
      const hit = await frame.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 12000);
        if (/captcha|recaptcha|hcaptcha|verify you are human|security check/i.test(text)) return true;
        return !!document.querySelector(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey], [class*="captcha" i]'
        );
      }).catch(() => false);
      if (hit) return true;
    }
  } catch {}
  return false;
}

async function clickText(page, re) {
  const candidates = page.locator('button, a, input[type="submit"], [role="button"]');
  const n = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 80); i++) {
    const el = candidates.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').trim();
    const aria = ((await el.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (!re.test(text) && !re.test(aria)) continue;
    const disabled = await el.isDisabled().catch(() => false);
    if (disabled) continue;
    await el.click({ timeout: 8000 }).catch(() => null);
    return true;
  }
  return false;
}

async function reachApplicationForm(page, provider) {
  // Some Greenhouse/Lever links open directly on the form; others open a job detail page.
  const hasForm = async () => {
    for (const frame of page.frames()) {
      const count = await frame.locator('input, textarea, select').count().catch(() => 0);
      if (count >= 3) return true;
    }
    return false;
  };

  if (await hasForm()) return true;

  if (provider === 'greenhouse') {
    const links = [
      'a[href*="#app"]',
      'a[href*="application"]',
      'a[href*="/applications/"]',
      'button:has-text("Apply")',
    ];
    for (const sel of links) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);
        if (await hasForm()) return true;
      }
    }
  }

  if (provider === 'lever') {
    const links = [
      'a.postings-btn',
      'a:has-text("Apply for this job")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ];
    for (const sel of links) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);
        if (await hasForm()) return true;
      }
    }
  }

  if (await clickText(page, APPLY_TEXT)) {
    await page.waitForTimeout(1500);
    return await hasForm();
  }

  return await hasForm();
}

async function requiredBlockers(page) {
  const blockers = [];

  for (const frame of page.frames()) {
    const rows = await frame.evaluate(() => {
      function labelFor(el) {
        const id = el.id;
        if (id) {
          const l = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (l?.innerText) return l.innerText.trim();
        }
        const parent = el.closest('label');
        if (parent?.innerText) return parent.innerText.trim();
        return (el.getAttribute('aria-label') || el.name || el.placeholder || '').trim();
      }

      const out = [];
      for (const el of document.querySelectorAll('input, textarea, select')) {
        const type = String(el.type || el.tagName).toLowerCase();
        if (['hidden', 'submit', 'button', 'file'].includes(type)) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        if (el.disabled) continue;

        const required = el.required || el.getAttribute('aria-required') === 'true'
          || !!el.closest('[class*="required" i]')
          || /\*/.test(labelFor(el));
        if (!required) continue;

        let empty = false;
        if (type === 'checkbox' || type === 'radio') {
          if (el.name) {
            empty = !document.querySelector('input[name="' + CSS.escape(el.name) + '"]:checked');
          } else {
            empty = !el.checked;
          }
        } else if (el.tagName === 'SELECT') {
          const option = el.options?.[el.selectedIndex];
          const text = (option?.text || '').trim();
          empty = !el.value || /^(select|choose|please select|please choose)/i.test(text);
        } else {
          empty = !String(el.value || '').trim();
        }

        if (empty) {
          out.push({
            label: labelFor(el) || 'Required field',
            name: el.name || '',
            type,
            options: el.tagName === 'SELECT'
              ? Array.from(el.options || []).map((o) => (o.text || '').trim()).filter(Boolean)
              : null,
          });
        }
      }
      return out;
    }).catch(() => []);

    blockers.push(...rows);
  }

  const seen = new Set();
  return blockers.filter((b) => {
    const key = `${b.label}|${b.name}|${b.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function parkBlockers(profileId, jobId, blockers) {
  const parked = [];
  for (const b of blockers) {
    const fieldKey = canonicalKey(b.name || b.label, b.type);
    const r = await parkQuestion(profileId, {
      field_key: fieldKey,
      label: b.label,
      type: b.type,
      options: b.options,
      jobId,
    }).catch(() => null);
    if (r?.parked) parked.push(r.field_key);
  }
  return parked;
}

async function confirmSubmission(page) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const text = await visibleText(page);
    if (CONFIRM_RE.test(text)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

export async function applyAtsJob(profile, job, { armed = false } = {}) {
  const ats = detectAts(job?.url || '');
  if (!PROVIDERS.has(ats.key)) {
    return { state: 'unsupported', provider: ats.key, note: `ATS provider ${ats.key} is not enabled in this engine yet.` };
  }

  const ctx = await getContext(profile.id, `ats-${ats.key}`, {
    headless: true,
    stealth: true,
    offscreen: true,
  });
  const page = await ctx.newPage();

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);

    if (CAPTCHA_RE.test(await visibleText(page)) || await hasCaptcha(page)) {
      return {
        state: 'needs_input',
        provider: ats.key,
        note: 'CAPTCHA or human-verification challenge detected before form fill.',
        shot: await screenshot(page, profile.id, job.id, 'captcha'),
      };
    }

    const formReached = await reachApplicationForm(page, ats.key);
    if (!formReached) {
      return {
        state: 'error',
        provider: ats.key,
        note: 'Could not locate the application form.',
        shot: await screenshot(page, profile.id, job.id, 'no-form'),
      };
    }

    const fill = await autofillContext(ctx, profile, job, {
      mode: 'llm-fallback',
      overwrite: false,
      allPages: false,
    });

    await page.waitForTimeout(800);

    if (await hasCaptcha(page)) {
      return {
        state: 'needs_input',
        provider: ats.key,
        note: 'CAPTCHA or human-verification challenge detected after autofill.',
        fill,
        shot: await screenshot(page, profile.id, job.id, 'captcha-after-fill'),
      };
    }

    const blockers = await requiredBlockers(page);
    if (blockers.length) {
      const parked = await parkBlockers(profile.id, job.id, blockers);
      return {
        state: 'needs_input',
        provider: ats.key,
        note: `${blockers.length} required field(s) remain unresolved.`,
        missing: blockers,
        parked,
        fill,
        shot: await screenshot(page, profile.id, job.id, 'needs-input'),
      };
    }

    const finalShot = await screenshot(page, profile.id, job.id, 'ats-ready');

    if (!armed) {
      return {
        state: 'dry_run',
        provider: ats.key,
        note: 'ATS form filled and ready to submit; dry-run stopped before submission.',
        fill,
        shot: finalShot,
      };
    }

    const clicked = await clickText(page, SUBMIT_TEXT);
    if (!clicked) {
      return {
        state: 'error',
        provider: ats.key,
        note: 'Form was filled but no enabled submit button was found.',
        fill,
        shot: finalShot,
      };
    }

    const confirmed = await confirmSubmission(page);
    return {
      state: confirmed ? 'applied' : 'submit_clicked',
      provider: ats.key,
      note: confirmed
        ? `Application confirmed by ${ats.key}.`
        : `Submit was clicked on ${ats.key}, but no confirmation was observed.`,
      fill,
      shot: await screenshot(page, profile.id, job.id, confirmed ? 'ats-confirmed' : 'ats-unconfirmed'),
    };
  } catch (e) {
    return {
      state: 'error',
      provider: ats.key,
      note: String(e?.message || e).slice(0, 300),
      shot: await screenshot(page, profile.id, job.id, 'ats-error'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}
