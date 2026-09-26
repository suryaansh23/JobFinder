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
- `ATS_READY`
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


## External ATS safety model

External ATS jobs use a two-stage gate:

1. `ATS_QUEUED` means JobFinder may open and fill the form, but it must stop before final submission.
2. A successful dry proof moves the row to `ATS_READY`.
3. Only a live orchestrator run with `armed: true` may submit an `ATS_READY` row.
4. CAPTCHA, OTP, login walls, unknown required questions, unsupported widgets, and unconfirmed submit clicks move the row to `ACTION_REQUIRED` and create an intervention item.

Known providers are detected for Greenhouse, Lever, Workday, SmartRecruiters and iCIMS. Unknown generic career pages are never allowed to guess whether an ambiguous Apply button is a form-entry action or a final submission.

### Human intervention API

`GET /api/interventions?profile_id=<id>` lists open intervention items.

Resolve an item with:

```json
{
  "profile_id": "...",
  "id": "...",
  "answer": "optional answer",
  "resolution": "optional note",
  "requeue": true
}
```

Send that body with `PATCH /api/interventions`. If the intervention represents an application question, the supplied answer is stored in the answer bank and the job is safely requeued.
