import { readValuesFrom, writeValuesTo, batchWriteValues, spreadsheetMetadata, rawSheetsBatchUpdate } from './googleSheetsClient.js';

const SOURCE_TAB = 'Opportunity Tracker';
const EXEC_TAB = 'Application Execution Tracker';

const SOURCE_HEADERS = [
  'Lead ID','First Seen','Last Seen','Market','Lead Type','Role','Company','Location','Industry',
  'Fit Score','Priority','Source Platform','Source Type','Job / Post URL','Recruiter / Hiring Manager',
  'Public Contact / CTA','Visa / Relocation','Posting Date','Opportunity Status','Application Status',
  'Applied Date','Response Status','Interview Stage','Next Follow-up','Last Action','Notes',
  'CV Angle / Keywords','Duplicate Key','Last Verified','Owner','Direct Company Application URL',
  'Direct Careers Verification','Live Control','Eligibility Control','Submission Control',
  'Outreach Control','Referral Control','Execution Blocker','Next Execution Action','Next Action Due',
];

const EXEC_HEADERS = [
  'Application ID','Lead ID','Market','Priority','Fit Score','Role','Company','Location','Job URL',
  'Source Platform','Posting Date','Freshness Verified','Eligibility Rechecked','Application Route',
  'Portal / ATS','Application Started','Current Form Stage','CV Filename Used','CV Uploaded',
  'Cover Letter / Note','Custom Questions / Answers','Salary / CTC Entered','Notice Period Entered',
  'Relocation / Visa Answer','Submission Attempt Date','Submission Status','Verification Evidence',
  'Blocker','Next Action','Next Action Due','Outreach Status','Referral Status','Follow-up Status',
  'Last Follow-up Attempt','Retry Required','Last Verified / Audit Notes',
];

const STATUS = {
  NOT_APPLIED: 'NOT_APPLIED',
  RUNNING: 'RUNNING',
  DRY_RUN_OK: 'DRY_RUN_OK',
  ATS_QUEUED: 'ATS_QUEUED',
  APPLIED: 'APPLIED',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  FAILED: 'FAILED',
  HOLD: 'HOLD',
  SKIPPED: 'SKIPPED',
};

let execCache = null;
let execCacheAt = 0;

function index(headers) {
  return Object.fromEntries(headers.map((h, i) => [h, i]));
}
const SI = index(SOURCE_HEADERS);
const EI = index(EXEC_HEADERS);

function v(row, header) {
  return row[SI[header]] ?? '';
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function parseDate(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 20000 && n < 100000) {
    return Date.UTC(1899, 11, 30) + n * 86400000;
  }
  const d = Date.parse(String(value));
  return Number.isFinite(d) ? d : 0;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sourceConnector(source, url) {
  const s = normalized(source);
  const u = normalized(url);
  if (s.includes('naukri') || u.includes('naukri.com/')) return 'naukri';
  if (s.includes('linkedin') || u.includes('linkedin.com/')) return 'linkedin';
  return 'tracker';
}

function markerStatus(lastAction, applicationStatus, opportunityStatus) {
  const a = String(lastAction || '').toUpperCase();
  const app = normalized(applicationStatus);
  const opportunity = normalized(opportunityStatus);

  if (/^JOBFINDER:\s*RUNNING\b/.test(a)) return STATUS.RUNNING;
  if (/^JOBFINDER:\s*DRY_RUN_OK\b/.test(a)) return STATUS.DRY_RUN_OK;
  if (/^JOBFINDER:\s*ATS_QUEUED\b/.test(a)) return STATUS.ATS_QUEUED;
  if (/^JOBFINDER:\s*ACTION_REQUIRED\b/.test(a)) return STATUS.ACTION_REQUIRED;
  if (/^JOBFINDER:\s*FAILED\b/.test(a)) return STATUS.FAILED;

  if (/applied|submitted/.test(app)) return STATUS.APPLIED;
  if (/withdrawn|skip/.test(app)) return STATUS.SKIPPED;
  if (/closed|removed|duplicate|superseded|ineligible/.test(opportunity)) return STATUS.SKIPPED;
  return STATUS.NOT_APPLIED;
}

function routeFor(row) {
  const source = String(row.source || '');
  if (/naukri/i.test(source)) return 'Naukri on-site';
  if (/linkedin/i.test(source)) return 'LinkedIn';
  return 'External ATS / careers';
}

function portalFor(row) {
  if (row.connector === 'linkedin') return 'LinkedIn';
  if (row.connector === 'naukri') return 'Naukri';
  try { return new URL(row.url).hostname.replace(/^www\./, ''); } catch { return 'Company ATS'; }
}

export async function isSuryanshWorkbook() {
  const meta = await spreadsheetMetadata();
  const titles = new Set((meta.sheets || []).map((s) => s?.properties?.title));
  return titles.has(SOURCE_TAB) && titles.has(EXEC_TAB);
}

export async function readSuryanshRows() {
  const values = await readValuesFrom(SOURCE_TAB, 'A1:AN5086');
  const header = values[0] || [];
  if (!SOURCE_HEADERS.every((h, i) => String(header[i] || '').trim() === h)) {
    throw new Error('Opportunity Tracker schema has changed. JobFinder stopped rather than guessing column meanings.');
  }

  return values.slice(1).map((cells, i) => {
    const sheetRow = i + 2;
    const recordId = String(v(cells, 'Lead ID') || '').trim();
    if (!recordId) return null;

    const jobUrl = String(v(cells, 'Job / Post URL') || '').trim();
    const source = String(v(cells, 'Source Platform') || '').trim();
    const status = markerStatus(
      v(cells, 'Last Action'),
      v(cells, 'Application Status'),
      v(cells, 'Opportunity Status')
    );
    const live = normalized(v(cells, 'Live Control'));
    const eligibility = normalized(v(cells, 'Eligibility Control'));
    const priority = String(v(cells, 'Priority') || '').trim();
    const opportunity = normalized(v(cells, 'Opportunity Status'));

    const queueEligible = status === STATUS.NOT_APPLIED
      && !/closed|removed|duplicate|superseded|ineligible/.test(opportunity)
      && !live.includes('non-active')
      && !eligibility.includes('disqualified')
      && /apply/.test(priority.toLowerCase());

    return {
      tracker_mode: 'suryansh_v3',
      record_id: recordId,
      job_id: '',
      queued_at: v(cells, 'First Seen') || v(cells, 'Posting Date') || v(cells, 'Last Seen') || '',
      queued_at_ms: parseDate(v(cells, 'First Seen') || v(cells, 'Posting Date') || v(cells, 'Last Seen')),
      company: v(cells, 'Company'),
      role: v(cells, 'Role'),
      location: v(cells, 'Location'),
      market: v(cells, 'Market'),
      fit_score: Number(v(cells, 'Fit Score')) || 0,
      priority,
      source,
      source_type: v(cells, 'Source Type'),
      url: jobUrl,
      direct_url: v(cells, 'Direct Company Application URL'),
      posting_date: v(cells, 'Posting Date'),
      last_verified: v(cells, 'Last Verified'),
      live_control: v(cells, 'Live Control'),
      eligibility_control: v(cells, 'Eligibility Control'),
      status,
      apply_channel: '',
      cv: '',
      confirmation: v(cells, 'Last Action'),
      application_reference: '',
      applied_at: v(cells, 'Applied Date'),
      action_required: status === STATUS.ACTION_REQUIRED ? 'YES' : '',
      action_reason: v(cells, 'Execution Blocker'),
      last_attempt_at: v(cells, 'Last Verified'),
      attempts: 0,
      notes: v(cells, 'Notes'),
      sheet_row: sheetRow,
      connector: sourceConnector(source, jobUrl),
      queue_eligible: queueEligible,
    };
  }).filter(Boolean);
}

async function executionIndex() {
  if (execCache && Date.now() - execCacheAt < 30000) return execCache;
  const values = await readValuesFrom(EXEC_TAB, 'A1:AJ5000');
  const header = values[0] || [];
  if (!EXEC_HEADERS.every((h, i) => String(header[i] || '').trim() === h)) {
    throw new Error('Application Execution Tracker schema has changed. JobFinder stopped rather than overwriting the wrong columns.');
  }

  const byLead = new Map();
  for (let i = 1; i < values.length; i++) {
    const lead = String(values[i]?.[EI['Lead ID']] || '').trim();
    if (lead) byLead.set(lead, i + 1);
  }
  execCache = { values, byLead, nextRow: Math.max(2, values.length + 1) };
  execCacheAt = Date.now();
  return execCache;
}

function appId(recordId, sheetRow) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const tail = String(recordId || '').replace(/[^A-Za-z0-9]/g, '').slice(-6);
  return `AUTO-${stamp}-${tail || sheetRow}`;
}

async function ensureExecutionRow(row) {
  const idx = await executionIndex();
  const existing = idx.byLead.get(row.record_id);
  if (existing) return existing;

  const meta = await spreadsheetMetadata();
  const sheet = (meta.sheets || []).find((s) => s?.properties?.title === EXEC_TAB);
  if (!sheet) throw new Error('Application Execution Tracker tab is missing.');

  const destRow = idx.nextRow++;
  if (destRow > Number(sheet.properties?.gridProperties?.rowCount || 5000)) {
    await rawSheetsBatchUpdate([{
      appendDimension: {
        sheetId: sheet.properties.sheetId,
        dimension: 'ROWS',
        length: 500,
      },
    }]);
  }

  // Copy only structure/formulas from the first execution row, then overwrite every
  // row-specific input. AA:AC retain the existing workbook's relative formulas.
  await rawSheetsBatchUpdate([{
    copyPaste: {
      source: {
        sheetId: sheet.properties.sheetId,
        startRowIndex: 1,
        endRowIndex: 2,
        startColumnIndex: 0,
        endColumnIndex: 36,
      },
      destination: {
        sheetId: sheet.properties.sheetId,
        startRowIndex: destRow - 1,
        endRowIndex: destRow,
        startColumnIndex: 0,
        endColumnIndex: 36,
      },
      pasteType: 'PASTE_NORMAL',
      pasteOrientation: 'NORMAL',
    },
  }]);

  const first = new Array(26).fill('');
  first[EI['Application ID']] = appId(row.record_id, destRow);
  first[EI['Lead ID']] = row.record_id;
  first[EI['Market']] = row.market || '';
  first[EI['Priority']] = row.priority || '';
  first[EI['Fit Score']] = row.fit_score || '';
  first[EI['Role']] = row.role || '';
  first[EI['Company']] = row.company || '';
  first[EI['Location']] = row.location || '';
  first[EI['Job URL']] = row.url || '';
  first[EI['Source Platform']] = row.source || '';
  first[EI['Posting Date']] = row.posting_date || '';
  first[EI['Freshness Verified']] = /active|open/i.test(String(row.live_control || '')) ? 'Verified Active' : 'Needs Recheck';
  first[EI['Eligibility Rechecked']] = /disqual/i.test(String(row.eligibility_control || ''))
    ? 'Disqualified'
    : /border/i.test(String(row.eligibility_control || '')) ? 'Borderline' : 'Qualified';
  first[EI['Application Route']] = routeFor(row);
  first[EI['Portal / ATS']] = portalFor(row);
  first[EI['Application Started']] = 'Started';
  first[EI['Current Form Stage']] = 'JobFinder automation started';
  first[EI['Submission Attempt Date']] = today();
  first[EI['Submission Status']] = 'Not Submitted';

  await writeValuesTo(EXEC_TAB, `A${destRow}:Z${destRow}`, [first]);
  await writeValuesTo(EXEC_TAB, `AD${destRow}:AJ${destRow}`, [[
    '', '', '', '', '', 'No', `JobFinder created execution record ${new Date().toISOString()}`
  ]]);

  idx.byLead.set(row.record_id, destRow);
  return destRow;
}

function executionPatchFor(row, patch) {
  const status = patch.status || row.status;
  const note = String(patch.action_reason || patch.confirmation || '').slice(0, 1200);
  const date = today();
  const out = {
    applicationStarted: 'Started',
    stage: note || 'JobFinder automation update',
    attemptDate: date,
    submissionStatus: 'Not Submitted',
    retry: 'No',
    audit: note,
  };

  if (status === STATUS.RUNNING) {
    out.stage = 'JobFinder automation in progress';
    out.audit = 'Automated attempt started. Final state pending.';
  } else if (status === STATUS.DRY_RUN_OK) {
    out.applicationStarted = 'Completed';
    out.stage = 'Dry run completed - ready for live submission';
    out.audit = patch.confirmation || 'Dry run completed; nothing submitted.';
  } else if (status === STATUS.APPLIED) {
    out.applicationStarted = 'Completed';
    out.stage = patch.confirmation || 'Submitted - JobFinder confirmation observed';
    out.submissionStatus = 'Submitted - Verified';
    out.retry = 'No';
    out.audit = patch.confirmation || 'JobFinder observed positive submission confirmation.';
  } else if (status === STATUS.ACTION_REQUIRED) {
    out.stage = note || 'User action required';
    out.submissionStatus = 'Blocked';
    out.retry = 'Yes';
    out.audit = note || 'JobFinder stopped before verified submission.';
  } else if (status === STATUS.FAILED) {
    out.stage = note || 'Automation failed';
    out.submissionStatus = 'Failed';
    out.retry = 'Yes';
    out.audit = note || 'Automation failed before verified submission.';
  }

  return out;
}

export async function updateSuryanshRow(row, patch) {
  const status = patch.status || row.status;
  const updates = [];
  const stamp = today();
  const reason = String(patch.action_reason || patch.confirmation || '').slice(0, 1000);

  if (status === STATUS.APPLIED) {
    updates.push({ tab: SOURCE_TAB, range: `T${row.sheet_row}:U${row.sheet_row}`, values: [['Applied', patch.applied_at ? String(patch.applied_at).slice(0, 10) : stamp]] });
    updates.push({ tab: SOURCE_TAB, range: `Y${row.sheet_row}:Y${row.sheet_row}`, values: [[`JobFinder: APPLIED - ${patch.confirmation || 'verified submission'}`]] });
    updates.push({ tab: SOURCE_TAB, range: `AC${row.sheet_row}:AC${row.sheet_row}`, values: [[stamp]] });
  } else if (status === STATUS.RUNNING) {
    updates.push({ tab: SOURCE_TAB, range: `Y${row.sheet_row}:Y${row.sheet_row}`, values: [['JobFinder: RUNNING']] });
  } else if (status === STATUS.DRY_RUN_OK) {
    updates.push({ tab: SOURCE_TAB, range: `Y${row.sheet_row}:Y${row.sheet_row}`, values: [['JobFinder: DRY_RUN_OK - ready for live submission']] });
    updates.push({ tab: SOURCE_TAB, range: `AC${row.sheet_row}:AC${row.sheet_row}`, values: [[stamp]] });
  } else if (status === STATUS.ATS_QUEUED) {
    updates.push({ tab: SOURCE_TAB, range: `Y${row.sheet_row}:Y${row.sheet_row}`, values: [['JobFinder: ATS_QUEUED - waiting for company-site engine']] });
  } else if (status === STATUS.ACTION_REQUIRED) {
    updates.push({ tab: SOURCE_TAB, range: `Y${row.sheet_row}:Y${row.sheet_row}`, values: [[`JobFinder: ACTION_REQUIRED - ${reason || 'manual reconciliation required'}`]] });
    updates.push({ tab: SOURCE_TAB, range: `AC${row.sheet_row}:AC${row.sheet_row}`, values: [[stamp]] });
  } else if (status === STATUS.FAILED) {
    updates.push({ tab: SOURCE_TAB, range: `Y${row.sheet_row}:Y${row.sheet_row}`, values: [[`JobFinder: FAILED - ${reason || 'automation failed'}`]] });
    updates.push({ tab: SOURCE_TAB, range: `AC${row.sheet_row}:AC${row.sheet_row}`, values: [[stamp]] });
  } else if (status === STATUS.NOT_APPLIED && reason) {
    updates.push({ tab: SOURCE_TAB, range: `Y${row.sheet_row}:Y${row.sheet_row}`, values: [[`JobFinder: RETRY_PENDING - ${reason}`]] });
  }

  if (updates.length) await batchWriteValues(updates);

  // Queueing an external ATS is not yet an application attempt. Keep the execution
  // ledger clean until the ATS engine actually starts work.
  if (status !== STATUS.ATS_QUEUED && status !== STATUS.NOT_APPLIED) {
    const execRow = await ensureExecutionRow(row);
    const ep = executionPatchFor(row, patch);
    await batchWriteValues([
      { tab: EXEC_TAB, range: `P${execRow}:Q${execRow}`, values: [[ep.applicationStarted, ep.stage]] },
      { tab: EXEC_TAB, range: `Y${execRow}:Z${execRow}`, values: [[ep.attemptDate, ep.submissionStatus]] },
      { tab: EXEC_TAB, range: `AI${execRow}:AJ${execRow}`, values: [[ep.retry, ep.audit]] },
    ]);
  }

  return { ...row, ...patch, status };
}

export function suryanshQueueEligible(row) {
  return row?.tracker_mode === 'suryansh_v3' ? row.queue_eligible !== false : true;
}

export { SOURCE_TAB, EXEC_TAB };
