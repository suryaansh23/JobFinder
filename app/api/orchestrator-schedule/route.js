import {
  orchestratorScheduleStatus,
  setOrchestratorSchedule,
} from '../../../lib/orchestratorScheduler.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) throw new HttpError(400, 'profile_id required');
  const status = await orchestratorScheduleStatus(profileId);
  if (!status) throw new HttpError(404, 'profile not found');
  return Response.json(status);
});

export const PUT = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['profile_id']);
  const cfg = await setOrchestratorSchedule(body.profile_id, {
    enabled: body.enabled,
    armed: body.armed,
    everyMinutes: body.everyMinutes,
    limit: body.limit,
    dailyCap: body.dailyCap,
  });
  return Response.json({ ok: true, schedule: cfg });
});
