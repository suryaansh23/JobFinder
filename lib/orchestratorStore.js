import crypto from 'node:crypto';
import { all, run } from './db.js';

async function ensureTable() {
  await run(`CREATE TABLE IF NOT EXISTS orchestrator_runs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    selected_json TEXT,
    summary_json TEXT,
    error TEXT
  )`);
  await run('CREATE INDEX IF NOT EXISTS orchestrator_runs_profile ON orchestrator_runs(profile_id, started_at)');
}

export async function beginOrchestratorRun(profileId, { armed, selected }) {
  await ensureTable();
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO orchestrator_runs
      (id, profile_id, mode, state, started_at, selected_json)
     VALUES (?,?,?,?,?,?)`,
    [id, profileId, armed ? 'live' : 'dry_run', 'running', Date.now(), JSON.stringify(selected || [])]
  );
  return id;
}

export async function finishOrchestratorRun(id, summary) {
  await ensureTable();
  await run(
    `UPDATE orchestrator_runs SET state = ?, finished_at = ?, summary_json = ? WHERE id = ?`,
    ['done', Date.now(), JSON.stringify(summary || {}), id]
  );
}

export async function failOrchestratorRun(id, error) {
  await ensureTable();
  await run(
    `UPDATE orchestrator_runs SET state = ?, finished_at = ?, error = ? WHERE id = ?`,
    ['error', Date.now(), String(error?.message || error).slice(0, 2000), id]
  );
}

export async function recentOrchestratorRuns(profileId, limit = 20) {
  await ensureTable();
  return all(
    `SELECT * FROM orchestrator_runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?`,
    [profileId, Math.max(1, Math.min(Number(limit) || 20, 100))]
  );
}
