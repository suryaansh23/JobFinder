// Auto-fill engine.
//
// For every visible, eligible form field on every open Chromium page:
//   1. Exact field_key match (client-side, inside __jobfinderFill) → fill verbatim.
//   2. Semantic retrieval via all-minilm against the answer bank:
//        - high-confidence hit (cosine ≥ 0.55) → fill with the matched value.
//        - lower-confidence hit on a long-form field → use as LLM context.
//   3. Fields without a confident match → ask the chat model to draft, using job
//      context + bio + retrieved hits as the system prompt. An INSTRUCT model is
//      required here: short fields run at num_predict 80, and a reasoning model spends
//      that entire budget inside <think>, returning nothing. See lib/llm.js.
//   4. Resume PDF auto-attached to any visible file input.

import { answersAsMap, recordAnswer } from './answerBank.js';
import { chat, writeupSystemPrompt } from './llm.js';
import { retrieve } from './knowledge.js';
import { attachBestResumeToPage } from './resume.js';
import { linfo, lok, lwarn, lerr, lcmd } from './logger.js';
import { coverLetterFor, isCoverLetterField } from './coverLetter.js';

const SEMANTIC_CONFIDENT = 0.55;     // cosine — above this we trust the bank verbatim
const MAX_LLM_FIELDS_PER_PAGE = 12;  // cap LLM calls per page so a giant form doesn't take forever
const SEMANTIC_PARALLELISM = 6;      // parallel embedding/retrieval lookups per page
const LLM_PARALLELISM = 2;           // parallel LLM drafts (Ollama handles ~2 concurrent generations fine)

// Tiny concurrency limiter — runs `fn` over `items` with at most `n` in flight.
async function pMap(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { __err: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

// Choose which page to autofill. By default we target ONLY the currently visible
// (frontmost) tab — that matches what the user expects when they hit "Autofill" while
// looking at step 3 of a multi-step form. If we can't identify a visible page, we
// fall back to the most-recently-opened still-open page. Setting opts.allPages=true
// forces the old behavior of filling every open page.
async function selectTargetPages(ctx, { allPages = false } = {}) {
  const open = ctx.pages().filter((p) => !p.isClosed());
  if (allPages) return open;
  if (open.length <= 1) return open;

  // Ask each page if it's currently visible to the user (document.visibilityState).
  const visibility = await Promise.all(
    open.map(async (p) => {
      try {
        const visible = await p.evaluate(() => document.visibilityState === 'visible');
        return { page: p, visible };
      } catch {
        return { page: p, visible: false };
      }
    })
  );
  const focused = visibility.filter((v) => v.visible).map((v) => v.page);
  if (focused.length) return focused;
  // Fallback: the last opened page is the most likely to be the application.
  return [open[open.length - 1]];
}

/**
 * Run autofill against the user's currently-visible browser tab(s).
 *
 * mode:
 *   'standard'    — exact match → semantic match. Skip fields with no confident hit.
 *                    Fastest, no LLM calls. The default.
 *   'llm-fallback' — standard + LLM drafts for any field still unfilled (long or short
 *                    with guardrails). What the "Autofill" button uses.
 *   'llm-force'   — IGNORE exact/semantic. LLM tries every detected field (subject to
 *                    the per-page LLM budget). What the "LLM Fill" button uses.
 *
 * Every step emits a log line via lib/logger to the per-profile bus, so the UI's
 * terminal panel can show real-time progress.
 */
export async function autofillContext(ctx, profile, job, { mode = 'llm-fallback', overwrite = false, allPages = false, targetPage = null } = {}) {
  const pid = profile.id;
  const useLLM = mode !== 'standard';
  const llmForce = mode === 'llm-force';

  lcmd(pid, `▶ Autofill (${mode}) for "${job?.title || 'job'}"${job?.company ? ' @ ' + job.company : ''}`);
  const exactMap = await answersAsMap(pid);
  linfo(pid, `  Loaded ${Object.keys(exactMap).length} saved answers from bank.`);

  const summary = {
    mode,
    pages: 0,
    frames: 0,
    fieldsSeen: 0,       // total visible fields the observer found
    learned: 0,          // fields already filled by the user → saved to the bank
    filled: 0,           // exact key matches (step 1)
    semanticFilled: 0,   // semantic high-confidence (step 2)
    llmFilled: 0,        // LLM drafts (step 3)
    skipped: 0,
    protected: 0,        // fields you typed into while we worked — yours was kept
    llmErrors: [],
    resumeAttached: false,
    targetUrl: '',
  };

  const targets = targetPage ? (targetPage.isClosed() ? [] : [targetPage]) : await selectTargetPages(ctx, { allPages });
  if (!targets.length) {
    lwarn(pid, '  No open browser tab to target — open the application page first.');
    return summary;
  }

  for (const page of targets) {
    if (page.isClosed()) continue;
    summary.pages++;
    let pageUrl = '';
    try { pageUrl = page.url(); summary.targetUrl = pageUrl; } catch { /* closed */ }
    linfo(pid, `  → Page: ${pageUrl || '(unknown url)'}`);

    // Attach the CV that best matches THIS job, not just "the" CV.
    const att = await attachBestResumeToPage(page, pid, job).catch(() => null);
    if (att?.attached) {
      summary.resumeAttached = true;
      summary.cvUsed = att.label;
      if (att.source === 'variant' && att.coverage != null) {
        const alt = att.alternatives?.length
          ? ` (beat ${att.alternatives.map((a) => `${a.label} ${a.coverage}%`).join(', ')})`
          : '';
        lok(pid, `  ✓ Attached CV "${att.label}" — ${att.coverage}% match on ${att.requiredCount} requirement(s)${alt}`);
      } else {
        lok(pid, `  ✓ Attached CV "${att.label}".`);
      }
    }

    // Walk EVERY frame. Many ATSes (Workday, Greenhouse Embedded, Lever, iCIMS,
    // SmartRecruiters) render the form inside one or more nested iframes — the top
    // frame on its own would show zero fields.
    const frames = page.frames();
    linfo(pid, `  Scanning ${frames.length} frame(s) for fillable fields…`);
    let totalUnfilled = 0;

    for (const frame of frames) {
      try {
        const url = frame.url();
        if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) continue;
        const stats = await autofillFrame(frame, profile, job, exactMap, { useLLM, llmForce, overwrite, summary, pid });
        if (stats && stats.fieldsSeen > 0) {
          summary.frames++;
          totalUnfilled += stats.unfilledAfterStage1;
        }
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 160);
        summary.llmErrors.push(`frame ${frame.url()}: ${msg}`);
        lwarn(pid, `  ⚠ Frame ${frame.url()} skipped: ${msg}`);
      }
    }

    if (summary.fieldsSeen === 0) {
      lwarn(pid, '  ⚠ No fillable fields detected on this page. (Selects/radios/checkboxes are not yet supported; form may use shadow DOM or non-standard inputs.)');
    }
  }

  lcmd(pid, `■ Autofill done — learned:${summary.learned} exact:${summary.filled} semantic:${summary.semanticFilled} llm:${summary.llmFilled} skipped:${summary.skipped} (${summary.fieldsSeen} fields total)`);
  return summary;
}

// Fill a single frame. Returns { fieldsSeen, unfilledAfterStage1 } when our helper
// was present, or null when the frame had no autofill helper installed (cross-origin
// or detached). Emits a log line per field decision so the UI terminal can narrate.
async function autofillFrame(frame, profile, job, exactMap, { useLLM, llmForce, overwrite, summary, pid }) {
  const frameUrl = (() => { try { return frame.url(); } catch { return ''; } })();
  const short = frameUrl.length > 70 ? frameUrl.slice(0, 67) + '…' : frameUrl;

  // 1) Stage 1: client-side scan + exact-key fills (skipped entirely in llm-force mode).
  let result;
  try {
    result = await frame.evaluate(
      ({ answers, overwrite, llmForce }) =>
        window.__jobfinderFill ? window.__jobfinderFill(llmForce ? {} : answers, { overwrite }) : null,
      { answers: exactMap, overwrite, llmForce }
    );
  } catch (e) {
    lwarn(pid, `    ⚠ frame ${short} not reachable (cross-origin or detached)`);
    return null;
  }
  if (!result) return null; // observer script not installed in this frame

  // Harvest values the user typed manually BEFORE clicking autofill — the lazy-attach
  // model means our live observer binding wasn't active during their typing, so this
  // is the only point at which those typed values can be added to the answer bank.
  const prefilled = result.prefilled || [];
  if (prefilled.length) {
    let learned = 0;
    for (const p of prefilled) {
      try {
        await recordAnswer(profile.id, p);
        learned++;
      } catch { /* one bad row shouldn't block the rest */ }
    }
    if (learned) {
      summary.learned = (summary.learned || 0) + learned;
      lok(pid, `    📚 Learned ${learned} field(s) from what you'd already typed → saved to answer bank`);
    }
  }

  const seen = (result.filled || 0) + (result.unfilledTargets?.length || 0) + prefilled.length;
  summary.fieldsSeen += seen;
  summary.filled += result.filled || 0;

  if (seen === 0) return { fieldsSeen: 0, unfilledAfterStage1: 0 };

  linfo(pid, `    frame ${short}: ${seen} field(s) found, ${prefilled.length} already typed, ${result.filled || 0} filled from exact match`);

  const unfilled = result.unfilledTargets || result.llmTargets || [];
  if (!unfilled.length) {
    return { fieldsSeen: seen, unfilledAfterStage1: 0 };
  }

  // 2) Stage 2: PARALLEL semantic retrieval — skipped in llm-force mode (LLM does it all).
  let retrieved;
  if (llmForce) {
    retrieved = unfilled.map((target) => ({ target, hits: [], exact: null }));
  } else {
    retrieved = await pMap(unfilled, SEMANTIC_PARALLELISM, async (target) => {
      try {
        const { hits, exact } = await retrieve(profile, target.label || target.key, { k: 6 });
        return { target, hits, exact };
      } catch (e) {
        return { target, hits: [], exact: null, error: e };
      }
    });
  }

  // 3) Anything we can fill from the answer bank, fill now (serial, to avoid races
  //    on dynamic forms). In llm-force mode this loop is a no-op — every field falls
  //    through to the LLM pass.
  const llmCandidates = [];
  for (const r of retrieved) {
    if (r.__err) { summary.skipped++; continue; }
    const { target, hits, exact } = r;
    if (!llmForce && exact && exact.value) {
      if (await applyValue(frame, target, exact.value, { pid, summary, source: 'bank exact' })) summary.semanticFilled++;
      continue;
    }
    const best = hits[0];
    if (!llmForce && best && best.score >= SEMANTIC_CONFIDENT) {
      if (await applyValue(frame, target, best.value, { pid, summary, source: `semantic ${best.score.toFixed(2)}` })) summary.semanticFilled++;
      continue;
    }
    llmCandidates.push({ target, hits });
  }

  // 4) LLM pass: bounded-parallel drafts.
  if (!useLLM || !llmCandidates.length) {
    if (llmCandidates.length) {
      summary.skipped += llmCandidates.length;
      for (const { target } of llmCandidates) {
        lwarn(pid, `    – ${target.label}: no bank match, LLM disabled → left blank`);
      }
    }
    return { fieldsSeen: seen, unfilledAfterStage1: llmCandidates.length };
  }

  const bounded = llmCandidates.slice(0, MAX_LLM_FIELDS_PER_PAGE);
  if (llmCandidates.length > bounded.length) {
    summary.skipped += llmCandidates.length - bounded.length;
    lwarn(pid, `    ⚠ LLM budget reached (${MAX_LLM_FIELDS_PER_PAGE}/page); ${llmCandidates.length - bounded.length} field(s) skipped`);
  }

  linfo(pid, `    Drafting ${bounded.length} field(s) with the LLM (concurrency ${LLM_PARALLELISM})…`);

  const drafts = await pMap(bounded, LLM_PARALLELISM, async ({ target, hits }) => {
    try {
      // A cover-letter box is not a generic long answer. Answering it from retrieved
      // snippets produces exactly the bland paragraph reviewers skim past, so route it
      // to the dedicated writer, which reads the job description and the matching CV
      // and caches its result on the job.
      if (isCoverLetterField(target.label, target.key)) {
        const { text, source } = await coverLetterFor(profile, job, { mode: 'auto' });
        if (text) {
          linfo(pid, `    ✉ ${target.label}: using ${source} cover letter (${text.split(/\s+/).length} words)`);
          return { target, text };
        }
      }
      const text = target.isLong
        ? await draftLongAnswer(profile, job, target, hits)
        : await draftShortAnswer(profile, job, target, hits);
      return { target, text };
    } catch (e) {
      return { target, error: e };
    }
  });

  for (const d of drafts) {
    if (d.error) {
      const msg = String(d.error?.message || d.error).slice(0, 200);
      summary.llmErrors.push(`${d.target.label}: ${msg}`);
      lerr(pid, `    ✗ ${d.target.label}: LLM error — ${msg}`);
      continue;
    }
    const text = (d.text || '').trim();
    if (!text || /^\[BLANK\]$/i.test(text)) {
      summary.skipped++;
      lwarn(pid, `    – ${d.target.label}: LLM had no grounded answer → left blank`);
      continue;
    }
    if (await applyValue(frame, d.target, text, { pid, summary, source: `LLM ${d.target.isLong ? 'long' : 'short'}` })) {
      summary.llmFilled++;
    }
  }
  return { fieldsSeen: seen, unfilledAfterStage1: bounded.length };
}

function truncate(s, n = 60) {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * Strip the conversational wrapper an instruct model puts around an answer.
 *
 * Asked to write a form answer, qwen opens with "Certainly! Here's a detailed response
 * to describe a project..." — measured, not hypothetical. That sentence would be typed
 * straight into the employer's textarea. Reasoning models leak a different tell
 * ("Okay, here is..."), so both shapes are handled.
 *
 * Only a LEADING preamble is removed, and only when something substantial follows;
 * trimming an answer down to nothing would be worse than leaving the preamble in.
 */
export function stripPreamble(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';

  t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
  // A reasoning model may still emit its block if the budget allowed it.
  t = t.replace(/^<think>[\s\S]*?<\/think>/i, '').trim();

  // Terminate on ':' or '!' only, and never on '.'. An earlier version allowed '.' as
  // the terminator with a greedy run before it, so the match ran to the LAST full stop
  // and swallowed the entire answer — replace() returned "". The length guard below
  // caught that and kept the original, which is why it looked like a no-op rather than
  // data loss, but the regex was still wrong.
  const PREAMBLE = /^(certainly|sure|of course|absolutely|okay|ok|here(?:'|’)?s|here is|below is|i(?:'|’)?d be happy to)\b[^\n:!?]{0,90}?[:!]\s+/i;
  for (let i = 0; i < 2; i++) {
    const next = t.replace(PREAMBLE, '').trim();
    if (next === t) break;
    if (next.length < 20) break;          // that was the whole answer — keep the original
    t = next;
  }
  // A leading markdown heading is the same problem in another costume.
  t = t.replace(/^#{1,6}\s+[^\n]+\n+/, '').trim();
  return t;
}

async function draftLongAnswer(profile, job, target, hits) {
  const system = writeupSystemPrompt(profile, job, hits);
  return await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: `Form field label on the application:\n"${target.label}"\n\nWrite the candidate's answer.` },
  ], { num_predict: 700, temperature: 0.3 }).then(stripPreamble);
}

// Short-field LLM with strict guardrails. The model MUST either ground its answer in
// the candidate data we supply, or return the literal sentinel [BLANK] — never invent.
async function draftShortAnswer(profile, job, target, hits) {
  const system = writeupSystemPrompt(profile, job, hits) +
    '\n\nSHORT-FIELD MODE:\n' +
    '- This is a SHORT answer field (likely one word, number, yes/no, or short phrase).\n' +
    '- Reply with ONLY the field value — no explanation, no quotes, no preamble.\n' +
    '- If the candidate data above contains the answer (or makes it obvious), use it verbatim.\n' +
    '- Otherwise reply with the literal string [BLANK]. Do NOT invent values for phone, address, salary, visa status, dates, employer names, etc.';
  return await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: `Field label: "${target.label}"\nWhat is the candidate's answer? Respond with the value alone, or [BLANK].` },
  ], { num_predict: 80, temperature: 0.1 }).then(stripPreamble);
}

// Returns { ok, reason }. reason is one of:
//   filled | already | occupied | focused | locked | gone | error | unavailable
//
// 'occupied' and 'focused' mean the user typed there while we were working — we leave
// it alone. See the note in __jobfinderSetByPath for why that matters.
async function setValueInFrame(frame, target, value) {
  const selector = typeof target === 'string' ? target : target.selector;
  const fallback = typeof target === 'string' ? null : target.fallbackSelector;
  try {
    let r = await frame.evaluate(
      ({ path, val }) => window.__jobfinderSetByPath?.(path, val) ?? { ok: false, reason: 'unavailable' },
      { path: selector, val: value }
    );
    // Token attribute lost (framework replaced the node) — try the CSS path once.
    if (!r?.ok && r?.reason === 'gone' && fallback) {
      r = await frame.evaluate(
        ({ path, val }) => window.__jobfinderSetByPath?.(path, val) ?? { ok: false, reason: 'unavailable' },
        { path: fallback, val: value }
      );
    }
    return r || { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// Single place that writes and logs, so every fill path reports protection the same way.
async function applyValue(frame, target, value, { pid, summary, source }) {
  const r = await setValueInFrame(frame, target, value);
  if (r.ok && r.reason === 'filled') {
    lok(pid, `    ✓ ${target.label} ← "${truncate(value)}" (${source})`);
    return true;
  }
  if (r.reason === 'occupied' || r.reason === 'focused') {
    summary.protected = (summary.protected || 0) + 1;
    lwarn(pid, `    🛡 ${target.label}: you typed "${truncate(r.current || '', 40)}" while I was drafting — kept yours, discarded mine`);
    return false;
  }
  if (r.reason === 'already') return false;
  summary.skipped++;
  lwarn(pid, `    – ${target.label}: could not write (${r.reason})`);
  return false;
}
