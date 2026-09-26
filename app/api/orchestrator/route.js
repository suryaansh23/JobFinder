import { orchestratorStatus, runOrchestrator } from '../../../lib/orchestrator.js';
import { get } from '../../../lib/db.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { ensureSchedulerStarted } from '../../../lib/schedulerBoot.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export const GET = withErrorHandling(async (req) => {
  ensureSchedulerStarted();
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) throw new HttpError(400, 'profile_id required');
  const profile = await get('SELECT id FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new HttpError(404, 'profile not found');
  return Response.json(await orchestratorStatus(profileId));
});

export const POST = withErrorHandling(async (req) => {
  ensureSchedulerStarted();
  const body = await readJson(req);
  requireFields(body, ['profile_id']);
  const armed = body.armed === true;
  const limit = Math.max(1, Math.min(Number(body.limit) || 10, 25));
  const summary = await runOrchestrator(body.profile_id, { armed, limit });
  return Response.json(summary);
});
