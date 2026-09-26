import { detectAts } from './atsDetector.js';

export function routeAtsJob(job) {
  const ats = detectAts(job?.url || '');
  return {
    job_id: job?.id || null,
    url: job?.url || '',
    ats: ats.key,
    supported: ats.supported,
    host: ats.host,
    confidence: ats.confidence || 'low',
  };
}
