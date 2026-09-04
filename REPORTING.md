# Reporting Scheduler

TypeScript replacement for the **ProduuzitAPI 1.0.0.6** Power Automate solution
(export kept for reference in `ProduuzitAPI_1_0_0_6/`). It performs the same
job: once a day it GETs a configured list of Produuzit endpoints and writes the
JSON responses to a folder structure.

## Flow → module mapping

| Power Automate flow | TypeScript module | Notes |
|---------------------|-------------------|-------|
| `API_tokens json lezen schrijven` | `src/reporting/client.ts` | SharePoint `api_tokens.json` replaced by `REPORTING_REFRESH_TOKEN` (env) + optional `REPORTING_TOKEN_FILE` for rotated tokens |
| `GET Access token` | `src/reporting/client.ts` (`refreshReportingAccessToken`) | Same `POST /my_user/token/refresh/` call, on a **separate Produuzit API account** |
| `Produuzit pagination` | `src/reporting/client.ts` (`fetchAllReporting`) | Follows `next` links, max 60 pages, Bearer auth |
| `GET Endpoint to sharepoint` | `src/reporting/runner.ts` (`runOneEndpoint`) | Fetches, builds filename, writes to output store |
| `Post in Sharepoint` | `src/reporting/storage.ts` (`LocalFileStore`) | Writes locally; SharePoint adapter can implement the same `OutputStore` interface later |
| `Produuzit data` (daily recurrence) | `src/reporting/runner.ts` (`runReportingCycle`, `startReportingScheduler`) | Schedule comes from the exported SharePoint list CSV |
| Teams error card | event history | Failures are recorded in the persistent history and surface in the notification bell |

The SharePoint list **Produuzit_API_frequentie** is read as CSV from
`REPORTING_CONFIG_CSV` (default `data/produuzit_api_frequentie.csv` — a copy of
the list export). A SharePoint-backed `ScheduleSource` can be added later.

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

Files are written under `REPORTING_OUTPUT_DIR/{Opslaglocatie}/`, mirroring the
SharePoint layout `Shared Documents/API data/{Opslaglocatie}`.

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

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `REPORTING_ENABLED` | `false` | Start the in-server daily scheduler |
| `REPORTING_REFRESH_TOKEN` | — | Refresh token of the **reporting** API account (separate from `PRODUUZIT_REFRESH_TOKEN`) |
| `REPORTING_BASE_URL` | `PRODUUZIT_BASE_URL` | Produuzit base URL for reporting |
| `REPORTING_TIME` | `18:15` | Local run time (HH:mm) for the in-server scheduler |
| `REPORTING_TIMEZONE` | `Europe/Amsterdam` | Time zone for "today" decisions |
| `REPORTING_CONFIG_CSV` | `data/produuzit_api_frequentie.csv` | Schedule config (SharePoint list export) |
| `REPORTING_OUTPUT_DIR` | `data/reporting` | Where JSON results are written |
| `REPORTING_TOKEN_FILE` | `data/reporting_tokens.json` | Persists rotated tokens (`api_tokens.json` replacement); delete/unset to use env only |
| `REPORTING_LAST_RUN_FILE` | `data/reporting_last_run.json` | Local "Laatste run" state (the original PATCHed the SharePoint list) |
| `REPORTING_PAGE_SIZE` | `1000` | Records per page requested from Produuzit |
| `REPORTING_MAX_PAGES` | `60` | Safety cap on pages per endpoint (raise if a list exceeds it) |

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
- **Filenames**: trailing ` - ` left by the `/` → ` - ` replacement is trimmed
  (`overview - production.json` instead of `overview - production - .json`).
- **Teams notifications**: replaced by the persistent event history + toast
  notifications in the app.

## Remaining SharePoint work (later)

- `ScheduleSource` backed by the live SharePoint list (instead of the CSV copy).
- `OutputStore` backed by SharePoint (site `Produuzit-APIdata`, folder
  `Shared Documents/API data/...`).
- `LastRunStore` that PATCHes the list item's `Laatste run` column.
