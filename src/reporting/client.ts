// Reporting Produuzit client — a dedicated API account, separate from the
// service account used by the rest of the repo.
//
// Replaces three Power Automate flows:
//   - "API_tokens json lezen schrijven" (api_tokens.json in SharePoint)
//   - "GET Access token" (refresh token → access token)
//   - "Produuzit pagination" (GET with Bearer token, follows `next` links)
//
// Token seeding/persistence:
//   - The refresh token is a setting (reporting_refresh_token), seeded from
//     REPORTING_REFRESH_TOKEN in .env and editable on the admin page.
//   - On rotation the new refresh token is saved back to the settings store, so
//     the freshest token survives restarts.

import { recordEvent } from "../db.js";
import { logger } from "../logger.js";
import { getReportingSettings, saveSettings } from "../settings.js";

let accessToken: string | null = null;

// Join the reporting base URL with a path, tolerating either a trailing slash
// on the base or a leading slash on the path. Endpoints in the schedule have no
// leading slash (e.g. "overview/production/"), so this is essential.
function joinBaseUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = baseUrl.replace(/\/+$/, "");
  const p = pathOrUrl.replace(/^\/+/, "");
  return `${base}/${p}`;
}

export async function refreshReportingAccessToken(): Promise<string> {
  const s = getReportingSettings();
  const rt = s.refreshToken;
  if (!rt) {
    throw new Error(
      "No reporting refresh token configured. Set REPORTING_REFRESH_TOKEN in .env " +
      "or configure it on the admin page (separate Produuzit API account).",
    );
  }
  const refreshUrl = joinBaseUrl(s.baseUrl, "my_user/token/refresh/");
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
    saveSettings({ reporting_refresh_token: data.refresh });
    recordEvent({ category: "reporting", level: "info", summary: "Refresh token rotated" });
  }
  recordEvent({ category: "reporting", level: "info", summary: "Access token refreshed" });
  return data.access;
}

async function ensureAccessToken(): Promise<string> {
  if (!accessToken) await refreshReportingAccessToken();
  return accessToken as string;
}

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

// Fetch one endpoint and collect all pages of results.
// Handles paginated bodies ({ results, next }), plain arrays and single objects.
export async function fetchAllReporting(path: string): Promise<unknown[]> {
  const s = getReportingSettings();
  const items: unknown[] = [];
  // Request the largest page size so list endpoints need fewer round-trips.
  const initialPath = path.includes("?")
    ? `${path}&limit=${s.pageSize}`
    : `${path}?limit=${s.pageSize}`;
  let url: string | null = joinBaseUrl(s.baseUrl, initialPath);
  let pages = 0;

  while (url && pages < s.maxPages) {
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
      recordEvent({ category: "reporting", level: "error", summary: `GET ${path}`, detail: `${res.status} ${body.slice(0, 300)}` });
      throw new Error(`GET ${path}: ${res.status} ${body.slice(0, 300)}`);
    }

    const json: unknown = await res.json();

    if (Array.isArray(json)) {
      items.push(...json);
      url = null;
    } else if (json && typeof json === "object" && Array.isArray((json as { results?: unknown[] }).results)) {
      // Paginated list response — flatten results and follow the next link.
      items.push(...(json as { results: unknown[] }).results);
      const next = (json as { next?: unknown }).next;
      url = typeof next === "string" && next.trim() ? joinBaseUrl(s.baseUrl, next.trim()) : null;
    } else {
      items.push(json);
      url = null;
    }
  }

  if (pages >= s.maxPages) {
    logger.warn(
      `[reporting] ${path}: stopped after ${s.maxPages} pages (${items.length} items so far) — ` +
      `raise reporting_max_pages if the dataset is larger`,
    );
  }
  return items;
}
