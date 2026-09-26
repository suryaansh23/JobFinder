import { get, all } from '../../../lib/db.js';
import { routeAtsJob } from '../../../lib/atsRouter.js';
import { withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  const jobId = searchParams.get('job_id');

  if (jobId) {
    const job = await get('SELECT id, profile_id, title, company, url FROM jobs WHERE id = ?', [jobId]);
    if (!job) throw new HttpError(404, 'job not found');
    if (profileId && job.profile_id !== profileId) throw new HttpError(404, 'job not found');
    return Response.json({ job: { ...job, route: routeAtsJob(job) } });
  }

  if (!profileId) throw new HttpError(400, 'profile_id required');

  const jobs = await all(
    `SELECT j.id, j.title, j.company, j.url, o.tracker_status
       FROM jobs j
       JOIN orchestrator_rows o ON o.job_id = j.id
      WHERE j.profile_id = ? AND o.tracker_status = 'ATS_QUEUED'
      ORDER BY o.sheet_row DESC
      LIMIT 500`,
    [profileId]
  );

  return Response.json({
    jobs: jobs.map((job) => ({ ...job, route: routeAtsJob(job) })),
  });
});
