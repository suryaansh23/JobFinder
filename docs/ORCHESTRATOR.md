# JobFinder Orchestrator

The orchestrator makes a Google Sheet the business source of truth while keeping SQLite/Postgres as runtime state.

## Tracker tab

Default tab: `Automation Queue`

The first row must contain exactly these columns:

`record_id, job_id, queued_at, company, role, location, source, url, priority, status, apply_channel, cv, confirmation, application_reference, applied_at, action_required, action_reason, last_attempt_at, attempts, notes`

Supported business states:

- `NOT_APPLIED`
- `RUNNING`
- `DRY_RUN_OK`
- `ATS_QUEUED`
- `APPLIED`
- `ACTION_REQUIRED`
- `FAILED`
- `HOLD`
- `SKIPPED`

Rows are processed LIFO: newest `queued_at` first; when timestamps are identical, the bottom-most Sheet row is processed first.

## Google configuration

Set:

```
JOBFINDER_TRACKER_SPREADSHEET_ID=
JOBFINDER_TRACKER_TAB=Automation Queue
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

The Google OAuth grant must include permission to read and edit Google Sheets.

## API

Status:

`GET /api/orchestrator?profile_id=<id>`

Dry run:

```json
{ "profile_id": "...", "armed": false, "limit": 10 }
```

Live run:

```json
{ "profile_id": "...", "armed": true, "limit": 10 }
```

POST those bodies to `/api/orchestrator`.

Phase 2 submits LinkedIn/Naukri on-site applications through the existing JobFinder engine. External ATS rows move to `ATS_QUEUED` and wait for the dedicated ATS engine rather than being guessed at.

## 24x7 discovery loop

When the Sheet orchestrator schedule is enabled, discovery scanning is enabled by default.
A scheduled slot performs:

1. scan all registered JobFinder sources when the scan interval is due
2. export newly discovered, unmirrored jobs into `Automation Queue`
3. deduplicate by canonical job key across sources
4. ingest remote answers from `Interventions`
5. process the refreshed LIFO queue

Schedule controls:

```json
{
  "profile_id": "...",
  "enabled": true,
  "armed": false,
  "everyMinutes": 60,
  "limit": 10,
  "dailyCap": 30,
  "scan": true,
  "scanEveryMinutes": 60
}
```

Set `armed:false` for discovery + autofill dry-runs with no final submission.

