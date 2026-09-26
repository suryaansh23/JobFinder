import { gmailStatus } from '../../../lib/gmail.js';
import { saveTrackerConfig, trackerConfigStatus } from '../../../lib/trackerConfig.js';
import { ensureTrackerLayout } from '../../../lib/masterTracker.js';
import { readJson, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  return Response.json({
    tracker: trackerConfigStatus(),
    google: gmailStatus(),
  });
});

export const PUT = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const cfg = saveTrackerConfig({
    spreadsheetId: body.spreadsheet_id,
    spreadsheetUrl: body.spreadsheet_url,
    tab: body.tab,
  });

  const google = gmailStatus();
  let validated = false;
  let validationError = '';

  if (google.connected) {
    try {
      await ensureTrackerLayout();
      validated = true;
    } catch (e) {
      validationError = String(e?.message || e).slice(0, 400);
    }
  } else {
    validationError = 'Google is not connected yet. Save is complete; reconnect Google, then validate again.';
  }

  return Response.json({
    ok: true,
    tracker: { configured: true, ...cfg },
    google,
    validated,
    validationError,
  });
});

export const POST = withErrorHandling(async () => {
  if (!trackerConfigStatus().configured) throw new HttpError(400, 'Tracker Sheet is not configured.');
  await ensureTrackerLayout();
  return Response.json({ ok: true, validated: true });
});
