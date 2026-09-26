import { get } from '../../../lib/db.js';
import { listNeedsInput } from '../../../lib/answerBank.js';
import { syncRemoteInterventions } from '../../../lib/remoteInterventions.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) throw new HttpError(400, 'profile_id required');
  const profile = await get('SELECT id FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new HttpError(404, 'profile not found');
  return Response.json({ questions: await listNeedsInput(profileId) });
});

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['profile_id']);
  const profile = await get('SELECT id FROM profiles WHERE id = ?', [body.profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');
  return Response.json({ ok: true, ...(await syncRemoteInterventions(body.profile_id)) });
});
