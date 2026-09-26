import { listInterventions, resolveIntervention } from '../../../lib/interventionQueue.js';
import { get } from '../../../lib/db.js';
import { openInChrome } from '../../../lib/browser.js';
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


export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['profile_id', 'id']);
  const item = await get(
    'SELECT i.*, j.url AS job_url FROM interventions i LEFT JOIN jobs j ON j.id = i.job_id WHERE i.id = ? AND i.profile_id = ?',
    [body.id, body.profile_id]
  );
  if (!item) throw new HttpError(404, 'intervention not found');
  if (!item.job_url) throw new HttpError(400, 'intervention has no job URL');
  const opened = await openInChrome(body.profile_id, item.job_url);
  return Response.json({ ok: true, opened });
});
