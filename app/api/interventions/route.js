import { listInterventions, resolveIntervention } from '../../../lib/interventionQueue.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) throw new HttpError(400, 'profile_id required');
  const state = searchParams.get('state') || 'open';
  const items = await listInterventions(profileId, { state, limit: searchParams.get('limit') || 100 });
  return Response.json({ interventions: items });
});

export const PATCH = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['profile_id', 'id']);
  try {
    const item = await resolveIntervention(body.profile_id, body.id, {
      answer: body.answer,
      resolution: body.resolution,
      requeue: body.requeue !== false,
    });
    return Response.json({ ok: true, intervention: item });
  } catch (e) {
    if (String(e?.message || e).includes('not found')) throw new HttpError(404, 'intervention not found');
    throw e;
  }
});
