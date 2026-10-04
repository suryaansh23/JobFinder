// Answers that are computed, not remembered.
//
// A few form fields have a right answer that changes every day. "Notice period" is the
// obvious one: if your last working day is fixed, the honest answer shrinks by one each
// morning. Storing "45 days" in the answer bank makes it wrong tomorrow and badly wrong
// in six weeks — and it is wrong in the direction that matters, because a recruiter
// plans around the date you gave them.
//
// So the source of truth is the DATE, entered once, and the number is derived at the
// moment a form asks for it.
//
// These take precedence over anything stored in the bank, and they are the only case
// where auto-apply fills a field without a human having typed that exact value: the
// user supplied the fact (their last working day), we are only doing the arithmetic.

import { parseFilters } from './profileSettings.js';

/** Whole days from today until `date`, floored at 0. Timezone-naive on purpose — a
 *  notice period is counted in calendar days, not hours. */
export function daysUntil(dateStr, now = Date.now()) {
  if (!dateStr) return null;
  const target = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.max(0, Math.round((target.getTime() - midnight) / 86400000));
}

function isoLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Add calendar months, clamping to the last valid day of the target month.
 * Example: Jan 31 + 1 month -> Feb 28/29.
 */
export function addCalendarMonths(date, months = 1) {
  const src = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const wantedDay = src.getDate();
  const target = new Date(src.getFullYear(), src.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(wantedDay, lastDay));
  return target;
}

export function lastWorkingDay(profile, now = Date.now()) {
  const f = parseFilters(profile);
  if (f.notice_period_mode === 'rolling_1_month') {
    return isoLocalDate(addCalendarMonths(new Date(now), 1));
  }
  return f.last_working_day || '';
}

// What counts as a notice-period question.
//
// Deliberately narrow. A false positive here types a number into a field that wanted
// something else, and unlike a wrong bank answer there is no human in the loop to catch
// it — so anything ambiguous is left to the ordinary answer bank.
const NOTICE_RE = /\b(notice\s*period|notice\s*\(?\s*in\s*days|period\s*of\s*notice|serving\s*notice)\b/i;
const JOIN_RE = /\b(how\s*soon\s*can\s*you\s*join|earliest\s*(possible\s*)?(start|joining)\s*date|when\s*can\s*you\s*(join|start)|availability\s*to\s*start|date\s*of\s*joining)\b/i;

/**
 * Compute an answer for `label`, or null if this is not a question we derive.
 *
 * @returns {{value: string, why: string} | null}
 */
export function derivedAnswer(profile, label, { type, options } = {}) {
  const lwd = lastWorkingDay(profile);
  if (!lwd) return null;
  const days = daysUntil(lwd);
  if (days == null) return null;
  const text = String(label || '');

  const isNotice = NOTICE_RE.test(text);
  const isJoin = JOIN_RE.test(text);
  if (!isNotice && !isJoin) return null;

  // A joining-date question wants a date, not a count.
  if (isJoin && !isNotice) {
    const asks = /date/i.test(text);
    if (asks) return { value: lwd, why: `your last working day (${lwd})` };
    return { value: String(days), why: `${days} day(s) until ${lwd}` };
  }

  // Dropdowns express notice as buckets ("30 days", "Immediate", "60-90 days").
  // Pick the bucket the real number falls into rather than forcing a number in.
  if (options && options.length) {
    const pick = matchNoticeOption(days, options);
    if (!pick) return null;   // fall through to the bank rather than guess
    return { value: pick, why: `${days} day(s) until ${lwd}` };
  }

  return { value: String(days), why: `${days} day(s) until ${lwd}` };
}

/**
 * Map a number of days onto whichever option the form offers.
 *
 * Handles the shapes these dropdowns actually use: "Immediate", "15 days", "30 Days",
 * "1 month", "60-90 days", "More than 90 days". Returns null when nothing fits, because
 * a notice period put in the wrong bucket is a lie told to a recruiter.
 */
export function matchNoticeOption(days, options) {
  const parsed = options.map((label) => {
    const s = String(label).toLowerCase();
    // \b0 matters: without it "0 day" matches the tail of "3-0- days", so "30 days",
    // "60 days" and "31-60 days" all parsed as Immediate — and a 45-day notice period
    // would have been reported to employers as "available now".
    if (/immediate|immediately|\b0\s*days?\b|available\s*now|ready\s*to\s*join/.test(s)) return { label, lo: 0, hi: 0 };

    const range = s.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*(day|month)/);
    if (range) {
      const mult = range[3] === 'month' ? 30 : 1;
      return { label, lo: Number(range[1]) * mult, hi: Number(range[2]) * mult };
    }
    const more = s.match(/(?:more than|greater than|above|\+)\s*(\d+)\s*(day|month)?/)
      || s.match(/(\d+)\s*(day|month)s?\s*\+/);
    if (more) {
      const mult = /month/.test(s) ? 30 : 1;
      return { label, lo: Number(more[1]) * mult + 1, hi: Infinity };
    }
    const one = s.match(/(\d+)\s*(day|month|week)/);
    if (one) {
      const mult = one[2] === 'month' ? 30 : one[2] === 'week' ? 7 : 1;
      const n = Number(one[1]) * mult;
      return { label, lo: n, hi: n };
    }
    return null;
  }).filter(Boolean);

  if (!parsed.length) return null;

  // An exact bucket wins.
  const inRange = parsed.find((p) => days >= p.lo && days <= p.hi);
  if (inRange) return inRange.label;

  // Otherwise take the smallest option that is still >= the real figure. Rounding UP is
  // deliberate: telling an employer you can start sooner than you can is the error that
  // costs you the offer.
  const above = parsed.filter((p) => p.lo >= days).sort((a, b) => a.lo - b.lo)[0];
  if (above) return above.label;

  // Everything on offer is shorter than the truth — say nothing rather than something false.
  return null;
}
