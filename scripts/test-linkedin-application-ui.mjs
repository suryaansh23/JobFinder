import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { LINKEDIN_APPLICATION_ROOT, inspectLinkedInApplication, openLinkedInApplication, clickApplicationButton } from '../lib/linkedinApplicationUi.js';

// Entirely local fixtures intercepted at the browser boundary. These tests never
// contact LinkedIn or use a candidate account, cookie, CV or real application.
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const id = '4482060285';
const origin = 'https://www.linkedin.com/jobs/view/' + id + '/';
let passed = 0;
async function fixture(html, test, applyHtml = html) {
  const page = await ctx.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: route.request().url().includes('/apply') ? applyHtml : html }));
  await page.goto(origin);
  try { await test(page); passed++; } finally { await page.close(); }
}
const form = '<h2>Apply to Example</h2><label>Email<input aria-label="Email"></label><button aria-label="Continue to next step">Next</button>';
const trigger = (dialog, label = 'Easy Apply', attrs = '') => '<button ' + attrs + ' onclick="if(event.isTrusted)document.getElementById(\'app\').style.display=\'block\'">' + label + '</button><section id="app" style="display:none">' + dialog + '</section>';
try {
  for (const tag of ['div role="dialog"', 'section role="dialog"', 'dialog open', 'div class="jobs-easy-apply-modal"']) {
    const end = tag.split(' ')[0];
    await fixture(trigger('<' + tag + '>' + form + '</' + end + '>'), async (page) => {
      const result = await openLinkedInApplication(page, id, { timeoutMs: 600 });
      assert.equal(result.state, 'ready', tag);
      assert.equal(await page.locator(LINKEDIN_APPLICATION_ROOT).count(), 1);
      assert.equal(await clickApplicationButton(page, LINKEDIN_APPLICATION_ROOT, /^next$/i), true);
    });
  }
  await fixture('<button hidden>Easy Apply</button>' + trigger('<section role="dialog">' + form + '</section>', '  Easy \n Apply  '), async (page) => {
    assert.equal((await openLinkedInApplication(page, id, { timeoutMs: 600 })).state, 'ready', 'hidden duplicate must not steal the click');
  });
  await fixture(trigger('<dialog open>' + form + '</dialog>', '<svg width="5" height="5"></svg>', 'aria-label="Easy Apply to Marketing Manager"'), async (page) => {
    assert.equal((await openLinkedInApplication(page, id, { timeoutMs: 600 })).state, 'ready', 'aria-only CTA');
  });
  await fixture('<a href="' + origin + '">Easy Apply</a>', async (page) => {
    const result = await openLinkedInApplication(page, id, { timeoutMs: 300 });
    assert.equal(result.state, 'ready', 'canonical same-job apply fallback');
    assert.ok(page.url().includes('/' + id + '/apply/'));
  }, '<form>' + form + '</form>');
  await fixture('<section role="dialog"><h2>Contact info</h2><input><button hidden>Submit application</button><button>Next</button></section>', async (page) => {
    assert.equal((await inspectLinkedInApplication(page, id)).state, 'ready');
    assert.equal(await clickApplicationButton(page, LINKEDIN_APPLICATION_ROOT, /^submit application$/i), false, 'hidden Submit is never clicked');
  });
  await fixture('<button onclick="window.outsideClicked=true">Submit application</button>', async (page) => {
    assert.equal(await clickApplicationButton(page, LINKEDIN_APPLICATION_ROOT, /^submit application$/i), false, 'missing form must not fall back to document');
    assert.equal(await page.evaluate(() => !!window.outsideClicked), false);
  });
  await fixture('<div role="dialog"><h2>Sign in</h2><input type="password"><button>Next</button></div>', async (page) => {
    assert.equal((await inspectLinkedInApplication(page, id)).state, 'auth_required');
    assert.equal(await page.locator(LINKEDIN_APPLICATION_ROOT).count(), 0);
  });
  await fixture('<p>Search jobs</p><form><input><button>Next</button></form>', async (page) => {
    assert.equal((await inspectLinkedInApplication(page, id)).state, 'pending', 'search form is not an application');
  });
  await fixture('<section role="dialog"><h2>Subscribe to updates</h2><input type="email"><button>Next</button></section>', async (page) => {
    assert.equal((await inspectLinkedInApplication(page, id)).state, 'pending', 'unrelated dialogs are not application forms');
  });
  await fixture('<button>Easy Apply</button>', async (page) => {
    assert.equal((await openLinkedInApplication(page, id, { timeoutMs: 200 })).state, 'ready', 'full-page server-driven application');
  }, '<main>' + form + '</main>');
  await fixture('<p>You reached today’s Easy Apply limit</p><button>Easy Apply</button>', async (page) => {
    assert.equal((await openLinkedInApplication(page, id, { timeoutMs: 300 })).state, 'rate_limited');
  });
  await fixture('<div role="dialog" hidden>' + form + '</div><button onclick="window.clicked=true">Easy Apply</button>', async (page) => {
    const r = await openLinkedInApplication(page, id, { timeoutMs: 200 });
    assert.equal(r.state, 'ui_unavailable', 'hidden stale dialog does not pass');
    assert.ok(r.diagnostics && !JSON.stringify(r.diagnostics).includes('Email'));
  });
  await fixture('<a href="https://www.linkedin.com/jobs/view/9999999999/apply/">Easy Apply</a>', async (page) => {
    const r = await openLinkedInApplication(page, id, { timeoutMs: 200 });
    assert.equal(r.state, 'ui_unavailable', 'another job is never followed');
    assert.equal(page.url(), origin);
  });
  await fixture('<section role="dialog"><h2>Resume application</h2><button onclick="this.parentNode.innerHTML=\'' + form.replace(/'/g, '&#39;').replace(/"/g, '&quot;') + '\'">Continue application</button></section>', async (page) => {
    assert.equal((await openLinkedInApplication(page, id, { timeoutMs: 600 })).state, 'ready', 'resume saved draft');
  });
  await fixture('<section role="dialog"><h2>Review your application</h2><button>Submit application</button></section>', async (page) => {
    assert.equal((await inspectLinkedInApplication(page, id)).state, 'ready', 'review page can have zero editable fields');
  });
  console.log('LinkedIn application UI browser regressions: PASS (' + passed + ' scenarios, no network)');
} finally { await browser.close(); }
