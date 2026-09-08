# Reporting Scheduler

TypeScript replacement for the **ProduuzitAPI 1.0.0.6** Power Automate solution
(export kept for reference in `ProduuzitAPI_1_0_0_6/`). It performs the same
job: once a day it GETs a configured list of Produuzit endpoints and writes the
JSON responses to a folder structure.

## Flow → module mapping

| Power Automate flow | TypeScript module | Notes |
|---------------------|-------------------|-------|
| `API_tokens json lezen schrijven` | `src/reporting/client.ts` | SharePoint `api_tokens.json` replaced by the `reporting_refresh_token` setting (seeded from `REPORTING_REFRESH_TOKEN`) |
| `GET Access token` | `src/reporting/client.ts` (`refreshReportingAccessToken`) | Same `POST /my_user/token/refresh/` call, on a **separate Produuzit API account** |
| `Produuzit pagination` | `src/reporting/client.ts` (`fetchAllReporting`) | Follows `next` links, max 60 pages, Bearer auth |
| `GET Endpoint to sharepoint` | `src/reporting/runner.ts` (`runOneEndpoint`) | Fetches, builds filename, writes to output store |
| `Post in Sharepoint` | `src/reporting/storage.ts` (`SharePointFileStore` / `LocalFileStore`) | Writes to SharePoint when `SHAREPOINT_*` env vars are set, otherwise locally |
| `Produuzit data` (daily recurrence) | `src/reporting/runner.ts` (`runReportingCycle`, `startReportingScheduler`) | Schedule lives in SQLite (seeded from the list CSV), editable on the admin page |
| Teams error card | event history | Failures are recorded in the persistent history and surface in the notification bell |

The SharePoint list **Produuzit_API_frequentie** is read as CSV from
`REPORTING_CONFIG_CSV` (default `data/produuzit_api_frequentie.csv` — a copy of
the list export). On first run the schedule is seeded from that CSV into the
SQLite `reporting_schedule` table; afterwards it is edited on the **admin page**
(not the CSV).

## How the schedule works

For each row in the config CSV where **In werking** is true:

| Type frequentie | Fires when |
|-----------------|------------|
| `Dagelijks` | today's Dutch weekday is in the row's **Dag van de week** list |
| `Wekelijks` | the first selected **Dag van de week** equals today's weekday |
| `Maandelijks` | **Dag van de maand** equals today's day-of-month |

When a row fires, the endpoint is fetched (all pages) and written as JSON:

- **Overschrijven = waar**: stable filename, e.g. `overview - production.json`
- **Overschrijven = niet waar**: timestamped filename, e.g.
  `overview - production Donderdag - Week 36.json` (weekday + ISO week number,
  same formula Power Automate used)

Files are written under `REPORTING_OUTPUT_DIR/{Opslaglocatie}/`, or to SharePoint
under `{SHAREPOINT_BASE_FOLDER}/{Opslaglocatie}/` when the SharePoint connection
is configured (see below).

### Deduplication / cumulative files

Records are keyed by a stable id (`uuid`, `id`, `guid` or `_id`; falls back to
the whole record).

- **Overschrijven = waar** (stable filename): fetched records are **merged** into
the existing file, so a record is never stored twice and a changed record is
replaced (latest wins). The file is a cumulative, deduplicated snapshot.
- **Overschrijven = niet waar** (timestamped filename): each run writes its own
snapshot, deduplicated within that run.

This avoids storing the same record twice, but the fetch itself is still a full
GET of the endpoint. True incremental fetching (skip already-seen records on the
API side) needs an endpoint-specific filter such as `?updated_at__gte=<last run>`;
that depends on the endpoint's query schema and is not yet wired.

The **Voorwaarden** (conditions) column is carried through the config but not
evaluated — the original flows never used it either.

## SharePoint output

Set all four `SHAREPOINT_*` connection vars in `.env` and the reporting module
writes its JSON snapshots to SharePoint (the original "Post in Sharepoint"
target) instead of the local output directory:

| Variable | Example |
|----------|---------|
| `SHAREPOINT_SITE_URL` | `https://blittanl.sharepoint.com/sites/Produuzit-APIdata` |
| `SHAREPOINT_TENANT_ID` | Azure AD tenant GUID |
| `SHAREPOINT_CLIENT_ID` | Azure AD app registration client id |
| `SHAREPOINT_CLIENT_SECRET` | Azure AD app registration client secret |
| `SHAREPOINT_BASE_FOLDER` | `Shared Documents/API data` (default) |

Auth is Azure AD app-only (OAuth2 client credentials) against the SharePoint
REST API. The app registration needs the **Sites.ReadWrite.All** permission.
Files land at `{SITE_URL}/{SHAREPOINT_BASE_FOLDER}/{Opslaglocatie}/{filename}`,
matching the original layout. Non-overwrite rows skip existing files (same
semantics as the local store).

## Running it

### One-shot run (test / Windows Task Scheduler)

```bat
npm run reporting
```

Runs one cycle and exits; exit code 1 when any endpoint failed.

### In-server daily scheduler

Set `REPORTING_ENABLED=true` in `.env` — the running server (`npm start`)
executes a cycle every day at `REPORTING_TIME` in `REPORTING_TIMEZONE`
(mirrors the original recurrence of 16:15 UTC = 18:15 NL time).

## Admin & configuration

Two kinds of users: **admins** (usernames listed in the `admin_usernames`
setting, seeded from `ADMIN_USERNAMES` in `.env`) and **everyone else** who can
log in to Produuzit. Admins see an **Admin** page where they configure
ModelBridge:

- admin usernames
- reporting settings (enabled, time, timezone, page size, max pages, output
  directory, base URL, refresh token)
- the reporting schedule (add / edit / delete endpoints)

Settings seed from environment variables and are stored in SQLite; the reporting
module reads them from the settings store, so changes take effect without a
restart (the scheduler re-checks `enabled` and `time` each tick). The reporting
refresh token is a setting too, and rotated tokens are saved back to it.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ADMIN_USERNAMES` | — | Comma-separated admin usernames (seed for the admin list) |
| `REPORTING_ENABLED` | `false` | Seed for the reporting-enabled setting |
| `REPORTING_REFRESH_TOKEN` | — | Seed for the reporting refresh-token setting (separate account) |
| `REPORTING_BASE_URL` | `PRODUUZIT_BASE_URL` | Produuzit base URL for reporting |
| `REPORTING_TIME` | `18:15` | Seed for the daily run time |
| `REPORTING_TIMEZONE` | `Europe/Amsterdam` | Time zone for "today" decisions |
| `REPORTING_CONFIG_CSV` | `data/produuzit_api_frequentie.csv` | One-time seed source for the schedule |
| `REPORTING_OUTPUT_DIR` | `data/reporting` | Where JSON results are written |
| `REPORTING_LAST_RUN_FILE` | `data/reporting_last_run.json` | Local "Laatste run" state (the original PATCHed the SharePoint list) |
| `REPORTING_PAGE_SIZE` | `1000` | Records per page requested from Produuzit |
| `REPORTING_MAX_PAGES` | `60` | Safety cap on pages per endpoint (raise if a list exceeds it) |
| `SHAREPOINT_SITE_URL` | — | SharePoint site for reporting output (enables SharePoint output when set with the next three) |
| `SHAREPOINT_TENANT_ID` | — | Azure AD tenant GUID |
| `SHAREPOINT_CLIENT_ID` | — | Azure AD app registration client id |
| `SHAREPOINT_CLIENT_SECRET` | — | Azure AD app registration client secret |
| `SHAREPOINT_BASE_FOLDER` | `Shared Documents/API data` | Base folder under the document library |

Output, token and state files under `data/` are git-ignored.

## Persistent history

All actions — reporting cycles as well as the regular Produuzit and Trimble API
calls — are recorded in the SQLite `events` table (`src/db.ts`). The frontend
notification bell hydrates from `GET /api/history` on load, and
`DELETE /api/history` clears it. So the last state of every API action is
always visible in the app.

## Deviations from the original flows

- **Pagination**: the original only flattened `results` when `next` was
  non-null, so single-page list responses were stored wrapped in the
  `{count, next, results}` envelope. Here `results` is always flattened.
- **HTTP 429**: retried up to 3 times with backoff instead of silently
  truncating the output.
- **Non-overwrite writes**: if the timestamped file already exists (second run
  on the same day), the file is skipped with a warning instead of failing.
- **Filenames**: kept byte-for-byte identical to Power Automate (including the
  trailing ` - ` on endpoints ending in `/`), because the existing Power BI
  report filters on the literal filename.
- **Teams notifications**: replaced by the persistent event history + toast
  notifications in the app.

## Remaining SharePoint work (later)

- `ScheduleSource` backed by the live SharePoint list (instead of the CSV copy).
- `LastRunStore` that PATCHes the list item's `Laatste run` column.
