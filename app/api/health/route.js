import { backendName, get } from '../../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  let db = 'ok';
  try {
    await get('SELECT 1 AS ok');
  } catch {
    db = 'error';
  }

  return Response.json({
    ok: db === 'ok',
    db,
    backend: backendName(),
    pid: process.pid,
    uptime_seconds: Math.floor(process.uptime()),
    now: Date.now(),
  }, { status: db === 'ok' ? 200 : 503 });
}
