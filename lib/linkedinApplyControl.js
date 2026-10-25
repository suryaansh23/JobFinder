// A LinkedIn page may show applications for unrelated jobs in its rail.
// This pure selector is intentionally conservative: prefer the active job's
// own control, leave ambiguous pages in SAFE rather than click the wrong job.
const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function chooseLinkedInApplyControl(candidates, jobId) {
  const id = String(jobId || '');
  if (!/^\d{6,}$/.test(id)) return null;
  const eligible = [];
  for (const c of candidates || []) {
    if (!c?.visible || c.disabled || c.inSidebar) continue;
    const labels = [normalize(c.text), normalize(c.aria)];
    const kind = labels.some((s) => /^easy apply(?: to\b.*)?$/i.test(s)) ? 'easy'
      : labels.some((s) => /^apply(?: to\b.*)?$/i.test(s)) ? 'external' : null;
    if (!kind) continue;
    const linkedId = String(c.href || '').match(/\/jobs\/view\/(\d+)/i)?.[1];
    if (linkedId && linkedId !== id) continue;
    // Cards can use 'urn:li:jobPosting:<id>' or plain numeric IDs.
    const contextId = String(c.contextJobId || '').match(/(\d{6,})/)?.[1];
    if (contextId && contextId !== id) continue;
    const ownLink = linkedId === id;
    const primary = !!(c.primary || c.applyButton);
    if (!ownLink && !primary && !c.inMain) continue;
    const score = (ownLink ? 30 : 0) + (primary ? 20 : 0)
      + (c.applyButton ? 10 : 0) + (c.inMain ? 1 : 0)
      + (kind === 'easy' ? 2 : 0);
    eligible.push({
      ...c, kind, score,
      hasApplyHref: /\/apply(?:\/|\?|$)/i.test(String(c.href || '')),
    });
  }
  eligible.sort((a, b) => b.score - a.score || (a.index ?? 0) - (b.index ?? 0));
  return eligible[0] || null;
}
