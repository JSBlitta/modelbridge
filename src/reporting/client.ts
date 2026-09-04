// Reporting Produuzit client — a dedicated API account, separate from the
// service account used by the rest of the repo.
//
// Replaces three Power Automate flows:
//   - "API_tokens json lezen schrijven" (api_tokens.json in SharePoint)
//   - "GET Access token" (refresh token → access token)
//   - "Produuzit pagination" (GET with Bearer token, follows `next` links)
//
// Token seeding/persistence:
//   - REPORTING_REFRESH_TOKEN (.env) seeds the refresh token.
//   - If REPORTING_TOKEN_FILE is set, rotated tokens are persisted there in the
//     same shape as the original api_tokens.json ({ Produuzit: { Access, Refresh } }),
//     so the freshest refresh token survives restarts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../env.js";
import { recordEvent } from "../db.js";
import { logger } from "../logger.js";

interface StoredTokens {
  Produuzit?: { Access?: string; Refresh?: string };
}

let refreshToken: string | null = null;
let accessToken: string | null = null;

function loadStoredTokens(): void {
  if (refreshToken || accessToken) return;
  let stored: StoredTokens = {};
  if (env.REPORTING_TOKEN_FILE && existsSync(env.REPORTING_TOKEN_FILE)) {
    try {
      stored = JSON.parse(readFileSync(env.REPORTING_TOKEN_FILE, "utf-8")) as StoredTokens;
    } catch {
      logger.warn(`[reporting] Could not parse ${env.REPORTING_TOKEN_FILE} — ignoring stored tokens`);
    }
  }
  refreshToken = stored.Produuzit?.Refresh ?? env.REPORTING_REFRESH_TOKEN ?? null;
  accessToken = stored.Produuzit?.Access ?? null;
}

function persistTokens(): void {
  if (!env.REPORTING_TOKEN_FILE) return;
  try {
    mkdirSync(dirname(env.REPORTING_TOKEN_FILE), { recursive: true });
    const payload: StoredTokens = { Produuzit: { Access: accessToken ?? "", Refresh: refreshToken ?? "" } };
    writeFileSync(env.REPORTING_TOKEN_FILE, JSON.stringify(payload, null, 2));
  } catch (e) {
    logger.warn(`[reporting] Could not persist tokens to ${env.REPORTING_TOKEN_FILE}: ${String(e)}`);
  }
}

// Join the reporting base URL with a path, tolerating either a trailing slash
// on the base or a leading slash on the path. Endpoints in the schedule CSV
// have no leading slash (e.g. "overview/production/"), so this is essential.
function joinBaseUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = env.REPORTING_BASE_URL.replace(/\/+$/, "");
  const p = pathOrUrl.replace(/^\/+/, "");
  return `${base}/${p}`;
}

export async function refreshReportingAccessToken(): Promise<string> {
  loadStoredTokens();
  const rt = refreshToken;
  if (!rt) {
    throw new Error(
      "No reporting refresh token configured. Set REPORTING_REFRESH_TOKEN in .env " +
      "(separate Produuzit API account from PRODUUZIT_REFRESH_TOKEN).",
    );
  }
  const refreshUrl = joinBaseUrl("my_user/token/refresh/");
  logger.debug(`[reporting] Refreshing access token via ${refreshUrl}`);
  const res = await fetch(refreshUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: rt }),
  });
  if (!res.ok) {
    const body = await res.text();
    recordEvent({ category: "reporting", level: "error", summary: "Token refresh failed", detail: `${res.status} ${body.slice(0, 300)}` });
    throw new Error(`Reporting token refresh failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { access: string; refresh?: string };
  accessToken = data.access;
  if (data.refresh && data.refresh !== rt) {
    refreshToken = data.refresh;
    recordEvent({ category: "reporting", level: "info", summary: "Refresh token rotated" });
  }
  persistTokens();
  recordEvent({ category: "reporting", level: "info", summary: "Access token refreshed" });
  return data.access;
}

async function ensureAccessToken(): Promise<string> {
  loadStoredTokens();
  if (!accessToken) await refreshReportingAccessToken();
  return accessToken as string;
}

const MAX_PAGES = 60; // same limit as the original Power Automate "Do until"
const MAX_RETRIES_429 = 3;

async function getUrl(url: string): Promise<Response> {
  let token = await ensureAccessToken();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (res.status === 401 || res.status === 403) {
    // Token expired or invalid — refresh once and retry
    token = await refreshReportingAccessToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  }
  return res;
}

function isNextUrl(next: unknown): string | null {
  if (typeof next !== "string" || !next.trim()) return null;
  return joinBaseUrl(next.trim());
}

// Fetch one endpoint and collect all pages of results.
// Handles paginated bodies ({ results, next }), plain arrays and single objects.
export async function fetchAllReporting(path: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let url: string | null = joinBaseUrl(path);
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    pages++;
    let res = await getUrl(url);

    // 429: back off briefly instead of silently truncating (the original flow
    // just skipped the page)
    for (let attempt = 0; res.status === 429 && attempt < MAX_RETRIES_429; attempt++) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      res = await getUrl(url);
    }

    if (res.status === 204) break; // empty but OK

    if (!res.ok) {
      const body = await res.text();
      const message = `GET ${path}: ${res.status} ${body.slice(0, 300)}`;
      recordEvent({ category: "reporting", level: "error", summary: `GET ${path}`, detail: `${res.status} ${body.slice(0, 300)}` });
      throw new Error(message);
    }

    const json: unknown = await res.json();

    if (Array.isArray(json)) {
      items.push(...json);
      url = null;
    } else if (json && typeof json === "object" && Array.isArray((json as { results?: unknown[] }).results)) {
      // Paginated list response — flatten results and follow the next link.
      // (The original flow only flattened when `next` was non-null, wrapping
      // single-page responses — fixed here.)
      items.push(...(json as { results: unknown[] }).results);
      url = isNextUrl((json as { next?: unknown }).next);
    } else {
      items.push(json);
      url = null;
    }
  }

  if (pages >= MAX_PAGES) {
    logger.warn(`[reporting] ${path}: stopped after ${MAX_PAGES} pages — response may be incomplete`);
  }
  return items;
}
