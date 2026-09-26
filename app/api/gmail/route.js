// Google connection + Gmail sync. Gmail access is read-only; the configured tracker Sheet is read/write.
//
//   GET  ?profile_id=…                     → status + captured messages
//   POST { action: 'save-client', client_id, client_secret }
//   POST { action: 'auth-url' }            → the Google consent URL to open
//   POST { action: 'sync', profile_id, days?, classify? }
//   POST { action: 'handled', profile_id, id, handled? }
//   POST { action: 'reanalyse', profile_id, id }
//   POST { action: 'disconnect', forgetClient? }
//
// The client secret is written to data/gmail.json (mode 0600) and is never returned by
// any endpoint — status reports booleans and the mailbox address, nothing more.

import { get } from '../../../lib/db.js';
import { gmailStatus, saveClient, authUrl, disconnectGmail } from '../../../lib/gmail.js';
import { mailStatus, saveAndVerify, forgetMail, testConnection, PRESETS } from '../../../lib/imapMail.js';
import { syncGmail, listEmails, markHandled, reanalyse } from '../../../lib/gmailSync.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export function redirectUriFor(req) {
  return `${new URL(req.url).origin}/api/gmail/callback`;
}

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  const status = {
    ...gmailStatus(),
    redirectUri: redirectUriFor(req),
    mail: mailStatus(),
    providers: Object.entries(PRESETS).map(([k, v]) => ({ id: k, ...v })),
  };
  status.anyConnected = status.connected || status.mail.connected;
  if (!profile_id) return Response.json({ ok: true, status, emails: [] });
  const emails = await listEmails(profile_id, {
    limit: Number(searchParams.get('limit')) || 60,
    onlyActionable: searchParams.get('actionable') === '1',
  });
  return Response.json({ ok: true, status, emails });
});

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { action } = body;
  requireFields({ action }, ['action']);

  if (action === 'save-client') {
    requireFields(body, ['client_id', 'client_secret']);
    return Response.json({ ok: true, status: saveClient(body.client_id, body.client_secret) });
  }

  if (action === 'auth-url') {
    const url = authUrl(redirectUriFor(req), body.profile_id || '');
    return Response.json({ ok: true, url });
  }

  // ── App-password path ──────────────────────────────────────────────────────
  if (action === 'mail-connect') {
    requireFields(body, ['user', 'pass']);
    try {
      const st = await saveAndVerify({
        user: body.user, pass: body.pass,
        provider: body.provider || 'gmail',
        host: body.host, port: body.port,
      });
      return Response.json({ ok: true, mail: st });
    } catch (e) {
      // Credentials are only stored once the server accepts them, so a failure here
      // leaves nothing behind to clean up.
      return Response.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (action === 'mail-test') {
    const r = await testConnection();
    return Response.json({ ok: r.ok, error: r.error, mailboxes: r.mailboxes });
  }

  if (action === 'mail-disconnect') {
    return Response.json({ ok: true, mail: forgetMail() });
  }

  if (action === 'disconnect') {
    return Response.json({ ok: true, status: disconnectGmail({ forgetClient: !!body.forgetClient }) });
  }

  requireFields(body, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [body.profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  if (action === 'sync') {
    try {
      const result = await syncGmail(profile, {
        days: Number(body.days) || 45,
        max: Math.min(Number(body.max) || 40, 100),
        classify: body.classify !== false,
      });
      return Response.json({ ok: true, ...result, emails: await listEmails(profile.id) });
    } catch (e) {
      // Surface WHAT to do. "Internal server error" for a disconnected mailbox is the
      // kind of message that sends you reading logs for a state the UI already knows.
      const msg = String(e?.message || e);
      const friendly =
        /not connected/i.test(msg) ? 'Gmail is not connected yet — set up credentials, then click Connect Gmail.'
        : /revoked|expired|invalid_grant/i.test(msg) ? 'Google access was revoked or expired — click Connect Gmail again.'
        : /Gmail API 4\d\d/.test(msg) ? `Google refused the request: ${msg}`
        : msg.slice(0, 200);
      return Response.json({ ok: false, error: friendly }, { status: 200 });
    }
  }

  if (action === 'handled') {
    requireFields(body, ['id']);
    await markHandled(profile.id, body.id, body.handled !== false);
    return Response.json({ ok: true });
  }

  if (action === 'reanalyse') {
    requireFields(body, ['id']);
    return Response.json({ ok: true, email: await reanalyse(profile, body.id) });
  }

  throw new HttpError(400, `unknown action: ${action}`);
});
