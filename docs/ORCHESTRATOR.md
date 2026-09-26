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
