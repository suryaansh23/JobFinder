import { get } from '../../../../lib/db.js';
import { applyAtsJob } from '../../../../lib/atsApply.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['profile_id', 'job_id']);

  const profile = await get('SELECT * FROM profiles WHERE id = ?', [body.profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  const job = await get('SELECT * FROM jobs WHERE id = ? AND profile_id = ?', [body.job_id, body.profile_id]);
  if (!job) throw new HttpError(404, 'job not found');

  const result = await applyAtsJob(profile, job, { armed: body.armed === true });
  return Response.json(result);
});
