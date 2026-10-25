import { get } from '../../../lib/db.js';
import { runOrchestrator } from '../../../lib/orchestrator.js';
import { readOrchestratorSchedule, evaluateAndAdvanceAutopilot } from '../../../lib/orchestratorScheduler.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { trackerReady } from '../../../lib/masterTracker.js';

// Runs one independent SAFE canary against the existing tracker. The user
// deliberately authorizes future LIVE submissions separately in the Windows
// controller. This endpoint cannot submit anything itself.
export const dynamic = 'force-dynamic';
export const maxDuration = 900;
export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [body.profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');
  const cfg = readOrchestratorSchedule(profile);
  if (!cfg.enabled || !cfg.promoteWhenReady || !cfg.autopilotConsent || cfg.armed) {
    throw new HttpError(409, 'AUTOPILOT is not authorized for this profile');
  }
  if (!(await trackerReady()).configured) throw new HttpError(503, 'Tracker not configured');
  const summary = await runOrchestrator(profile.id, { armed: false, limit: 3, canary: true });
  const promotion = await evaluateAndAdvanceAutopilot(profile.id, summary);
  return Response.json({ ...promotion, summary: {
    selected: summary.selected,
    routed: (summary.boardAutomatable || 0) + (summary.atsAutomatable || 0),
    prepared: (summary.engine?.dryRun || 0) + (summary.ats?.dryRun || 0),
    blocked: summary.engine?.deferredDetails || [],
    needsInput: (summary.engine?.needsInput || 0) + (summary.ats?.needsInput || 0),
  } });
});
