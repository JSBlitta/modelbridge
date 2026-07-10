# Fixes — 2026-06-26

## Auth

| Keyword | Fix |
|---------|-----|
| **session middleware** | Removed — user cookies gated API routes; `PRODUUZIT_REFRESH_TOKEN` (service token) is the sole API authorization |
| **auth/status** | Reads cookie + `db.getSession()` directly instead of `currentSession()` (which required the removed middleware) |
| **403 not handled** | `request()` now refreshes token on 403 too — Produuzit returns 403 (not 401) for expired access tokens |
| **refresh race** | Mutex (`refreshPromise`) serializes concurrent refreshes so only one call hits the Produuzit token endpoint |
| **token rotation** | `obtainAccessToken()` stores rotated refresh tokens returned by Produuzit |

## Routing

| Keyword | Fix |
|---------|-----|
| **trailing slash** | Middleware redirects `/api/*/` → `/api/*` (308) so the SPA catch-all doesn't intercept API calls |
| **serveStatic clash** | Changed `app.use("/*", ...)` to `app.get("/assets/*", ...)` — static handler no longer shadows API routes |

## Frontend

| Keyword | Fix |
|---------|-----|
| **batch suffix** | `BatchManager.vue` default suffix `'E'` → `''`; `buildBatchName()` only appends suffix/phase when supplied |
| **project cache** | `AssemblyUpdate.vue` caches projects/dbBatches at module level — survives Vue Router unmount/remount |
| **stale assemblies** | Switching project in AssemblyUpdate now clears old `assemblies`, `selectedBatch`, and `changedUuids` |
| **refresh button** | Added refresh button next to project dropdown in AssemblyUpdate to force-refetch |

## Server

| Keyword | Fix |
|---------|-----|
| **start command** | Use `cmd /c "cd /d ... && npx tsx src/index.ts"` — PowerShell `Set-Location` doesn't persist across tool calls |
