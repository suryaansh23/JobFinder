import { ensureSheetTab, readValues, batchWriteValues, writeValues } from './googleSheetsClient.js';

// Provider health is kept apart from candidate answers so an operational note
// can never enter the answer bank as a claimed fact about the candidate.
const TAB = 'Automation Health';
const HEADERS = ['profile_id','provider','status','checked_at','prepared','confirmed','unconfirmed','blockers','engine_version'];
export async function publishAutomationHealth(profileId, summary) {
  if (!summary.channels?.length) return;
  await ensureSheetTab(TAB);
  const existing = await readValues('A:I', TAB);
  const header = existing[0] || [];
  if (header.some((s) => String(s || '').trim()) && !HEADERS.every((s,i) => s === header[i])) return;
  if (!header.length) await writeValues('A1:I1', [HEADERS], TAB);
  const patches = [];
  let next = Math.max(2, existing.length + 1);
  for (const c of summary.channels) {
    const index = existing.findIndex((r,i) => i > 0 && r[0] === profileId && r[1] === c.channel);
    const row = index > 0 ? index + 1 : next++;
    const state = c.blocked.length || c.unconfirmed ? 'NEEDS_ATTENTION' : c.confirmed ? 'CONFIRMED_APPLICATIONS' : c.prepared ? 'PREPARED' : 'WAITING';
    patches.push({range:'A' + row + ':I' + row,values:[[profileId,c.channel,state,new Date().toISOString(),c.prepared,c.confirmed,c.unconfirmed,c.blocked.join(', '),summary.preparationVersion]]});
  }
  await batchWriteValues(patches,TAB);
}
