import { linkedinOwnApplyUrl } from './linkedinApplyUrl.js';
import { isLinkedInAuthWallUrl } from './applyDiagnostics.js';

// A marker on the actual, visible application surface. All field reads and
// button clicks must stay inside it, even when LinkedIn changes element tags.
export const LINKEDIN_APPLICATION_ROOT = '[data-jf-application-root="active"]';

export async function inspectLinkedInApplication(page, jobId) {
  if (isLinkedInAuthWallUrl(page.url())) return { state: 'auth_required' };
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(url.hostname)
    || !new RegExp('^/jobs/view/' + jobId + '(?:/|$)').test(url.pathname)) return { state: 'pending', snapshots: [] };
  return page.evaluate(({ id }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
        && !el.closest('[hidden],[aria-hidden="true"],[inert]');
    };
    document.querySelectorAll('[data-jf-application-root]').forEach((el) => el.removeAttribute('data-jf-application-root'));
    const text = document.body?.innerText || '';
    if (/reached today.{0,5}s easy apply limit|easy apply limit/i.test(text)) return { state: 'rate_limited' };
    const roots = [...document.querySelectorAll('dialog,[role="dialog"],[aria-modal="true"],.jobs-easy-apply-modal,.jobs-easy-apply-content,[data-test-modal],form,main,[role="main"]')];
    const applicationLanguage = /apply to\b|easy apply|application|contact info|resume|résumé|additional questions|work experience/i;
    const advance = /^(next|continue|continue to next step|review|review your application|submit application|send application|submit)$/i;
    const resume = /^(resume application|continue application|continue applying)$/i;
    const snapshots = [];
    for (const root of roots) {
      if (!visible(root)) continue;
      const label = norm(root.innerText) + ' ' + norm(root.getAttribute('aria-label'));
      const fields = [...root.querySelectorAll('input,select,textarea')].filter((e) => visible(e) && e.type !== 'hidden');
      // Account/password forms are never application surfaces.
      if (root.querySelector('input[type="password"],input[name="session_key"]')) continue;
      const buttons = [...root.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible);
      const names = buttons.map((el) => norm(el.innerText || el.value || el.getAttribute('aria-label')));
      const isForm = root.tagName === 'FORM';
      const applyRoute = new RegExp('^/jobs/view/' + id + '/apply/?$').test(location.pathname);
      if ((root.tagName === 'MAIN' || root.getAttribute('role') === 'main') && !applyRoute) continue;
      const related = applicationLanguage.test(label) || root.matches('.jobs-easy-apply-modal,.jobs-easy-apply-content');
      snapshots.push({ tag: root.tagName.toLowerCase(), role: root.getAttribute('role'), fields: fields.length, buttons: names.filter((n) => advance.test(n) || resume.test(n)) });
      if (!related || (isForm && !applyRoute && !/application|easy apply|apply to\b/i.test(label))) continue;
      if (names.some((n) => resume.test(n)) && !fields.length) {
        root.setAttribute('data-jf-application-root', 'active');
        return { state: 'resume', snapshots };
      }
      if ((fields.length || /application|resume|résumé/i.test(label)) && names.some((n) => advance.test(n))) {
        root.setAttribute('data-jf-application-root', 'active');
        return { state: 'ready', snapshots };
      }
    }
    if (document.querySelector('input[name="session_key"],form[action*="/login-submit"],input#username,input[type="password"]')) {
      return { state: 'auth_required', snapshots };
    }
    if (/verify (that )?you are human|security verification|complete (the )?security check/i.test(text)
      || document.querySelector('iframe[src*="captcha"],input[autocomplete="one-time-code"]')) {
      return { state: 'auth_required', snapshots };
    }
    return { state: 'pending', snapshots };
  }, { id: String(jobId) }).catch(() => ({ state: 'pending', snapshots: [] }));
}

// Use trusted locator clicks and normalized accessible labels. Never fall back
// to the whole document when a scoped application surface has disappeared.
export async function clickApplicationButton(page, rootSelector, re) {
  const root = page.locator(rootSelector).first();
  if (!await root.isVisible().catch(() => false)) return false;
  const buttons = root.locator('button,[role="button"],input[type="submit"]');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 60); i++) {
    const el = buttons.nth(i);
    if (!await el.isVisible().catch(() => false) || await el.isDisabled().catch(() => true)) continue;
    const text = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const aria = (await el.getAttribute('aria-label').catch(() => '') || '').replace(/\s+/g, ' ').trim();
    if (!re.test(text) && !re.test(aria)) continue;
    try { await el.click({ timeout: 6000 }); return true; } catch { /* Re-rendered; try another visible match. */ }
  }
  return false;
}

async function waitForApplication(page, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let result;
  let resumed = false;
  do {
    result = await inspectLinkedInApplication(page, jobId);
    if (['ready', 'auth_required', 'rate_limited'].includes(result.state)) return result;
    if (result.state === 'resume' && !resumed) {
      resumed = await clickApplicationButton(page, LINKEDIN_APPLICATION_ROOT, /^(resume application|continue application|continue applying)$/i);
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return result || { state: 'pending' };
}

export async function openLinkedInApplication(page, jobId, { timeoutMs = 9000 } = {}) {
  // Navigation targets and selected controls must refer to the chosen posting.
  const current = new URL(page.url());
  if (current.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(current.hostname)
    || !new RegExp('^/jobs/view/' + jobId + '(?:/|$)').test(current.pathname)) {
    return { state: 'ui_unavailable', note: 'LinkedIn did not load the selected posting; application controls were not clicked.' };
  }
  let seen = await inspectLinkedInApplication(page, jobId);
  if (['ready', 'auth_required', 'rate_limited'].includes(seen.state)) return seen;
  if (seen.state === 'resume') {
    seen = await waitForApplication(page, jobId, timeoutMs);
    if (['ready', 'auth_required', 'rate_limited'].includes(seen.state)) return seen;
  }
  const controls = await page.evaluate(({ id }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-jf-apply-control]').forEach((e) => e.removeAttribute('data-jf-apply-control'));
    const found = [];
    for (const el of document.querySelectorAll('a,button,[role="button"]')) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || el.disabled || el.getAttribute('aria-disabled') === 'true'
        || el.closest('[hidden],[aria-hidden="true"],[inert]') || getComputedStyle(el).visibility === 'hidden') continue;
      if (!/^easy apply$/i.test(norm(el.innerText)) && !/^easy apply(?: to\b|$)/i.test(norm(el.getAttribute('aria-label')))) continue;
      const href = el.getAttribute('href') || '';
      const owner = el.closest('[data-job-id]')?.getAttribute('data-job-id');
      const linkedId = href.match(/\/jobs\/view\/(\d+)/)?.[1];
      if ((owner && owner !== id) || (linkedId && linkedId !== id)) continue;
      const token = String(found.length);
      el.setAttribute('data-jf-apply-control', token);
      found.push({ token, href });
      if (found.length === 3) break;
    }
    return found;
  }, { id: String(jobId) });
  const attempts = [];
  for (const control of controls) {
    try {
      await page.locator('[data-jf-apply-control="' + control.token + '"]').click({ timeout: 6000 });
      attempts.push('visible-session-click');
    } catch { attempts.push('control-not-clickable'); }
    seen = await waitForApplication(page, jobId, timeoutMs);
    if (['ready', 'auth_required', 'rate_limited'].includes(seen.state)) return { ...seen, attempts };
  }
  if (controls.length) {
    const href = controls.map((c) => linkedinOwnApplyUrl(jobId, c.href)).find(Boolean)
      || linkedinOwnApplyUrl(jobId, '/jobs/view/' + jobId + '/apply/?openSDUIApplyFlow=true');
    if (href) {
      attempts.push('same-job-apply-route');
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      seen = await waitForApplication(page, jobId, timeoutMs);
      if (['ready', 'auth_required', 'rate_limited'].includes(seen.state)) return { ...seen, attempts };
    }
  }
  return {
    state: 'ui_unavailable',
    note: 'No usable application surface after ' + (attempts.join(', ') || 'no visible Easy Apply control'),
    // Structural counts only. No cookies, field values, profile data or HTML.
    diagnostics: { path: new URL(page.url()).pathname, controls: controls.length, surfaces: seen.snapshots || [], attempts },
  };
}
