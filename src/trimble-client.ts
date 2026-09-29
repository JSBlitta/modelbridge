import { randomUUID } from "node:crypto";
import { env } from "./env.js";
import { recordEvent, createPreviewToken, consumePreviewToken } from "./db.js";
import { logger } from "./logger.js";

let accessToken: string | null = null;
let refreshTokenVal: string | null = null;

// --- Temporary OAuth callback server (port 80) ---

interface OAuthProgress {
  completed: boolean;
  error: string | null;
  completedAt: string | null;
}

const oauthState: OAuthProgress = { completed: false, error: null, completedAt: null };

export function getOAuthState() {
  return {
    completed: oauthState.completed,
    error: oauthState.error,
    completed_at: oauthState.completedAt,
    authenticated: isAuthenticated(),
  };
}

export function markOAuthCompleted(error?: string | null): void {
  oauthState.completed = true;
  oauthState.error = error ?? null;
  oauthState.completedAt = new Date().toISOString();
}

// --- OAuth state parameter -------------------------------------------------
//
// The authorize URL previously carried no `state`, and the callback took its
// `redirect_uri` straight from the query string. Together those let anyone who
// could get an operator to open a crafted link complete the flow with their own
// authorization code, binding this app's shared Trimble connection to an account
// they controlled.
//
// Now a single-use state value is minted server-side and stored against the
// callback URL it was issued for. The callback rejects an absent or unknown
// state and takes the redirect_uri from that stored record, never from the
// request. Reuses the single-use token store rather than adding a second one.

const OAUTH_SCOPE = "oauth:trimble-state";

export function beginOAuth(callbackUrl: string): { state: string; url: string } {
  const state = randomUUID();
  createPreviewToken(state, callbackKey(callbackUrl), OAUTH_SCOPE);
  return { state, url: buildAuthorizeUrl(callbackUrl, state) };
}

// Consumes the state and returns the callback URL it was issued for, or null
// when it is missing, unknown, expired or already spent. The store deletes on
// first read, so the configured URLs are tried in turn until one matches.
export function redeemOAuthState(state: string | undefined): string | null {
  if (!state) return null;
  for (const candidate of getCallbackUrls()) {
    if (consumePreviewToken(state, callbackKey(candidate), OAUTH_SCOPE) === null) {
      return candidate;
    }
  }
  return null;
}

function callbackKey(callbackUrl: string): string {
  return `cb:${callbackUrl.trim().toLowerCase()}`;
}

const REGION_ENDPOINTS = {
  Core: "https://app21.connect.trimble.com/tc/api/2.0/",
  Model: "https://model-api21.connect.trimble.com/",
  Organizer: "https://org-api.eu-west-1.connect.trimble.com/v1/",
  // Trimble-defined property sets (see src/trimble-propertysets.ts). Same
  // europe region as the rest; the OAuth scope we already request
  // ("openid Datatable_extractor") covers it, so no re-consent is needed.
  Propertyset: "https://pset-api.eu-west-1.connect.trimble.com/v1/",
};

export function getRegionEndpoints() {
  return REGION_ENDPOINTS;
}

export function isAuthenticated(): boolean {
  return Boolean(accessToken || refreshTokenVal);
}

export function getRefreshToken(): string | null {
  return refreshTokenVal;
}

/** Restore a saved refresh token without overwriting one that is already in memory. */
export function restoreRefreshToken(token: string): void {
  if (!refreshTokenVal) refreshTokenVal = token.trim() || null;
}

export function clearTokens(): void {
  accessToken = null;
  refreshTokenVal = null;
}

export function setManualToken(token: string, refresh?: string | null): void {
  accessToken = token.trim() || null;
  refreshTokenVal = refresh?.trim() || null;
}

export function getCallbackUrls(): string[] {
  return env.TRIMBLE_CALLBACK_URLS;
}

export function buildAuthorizeUrl(callbackUrl?: string, state?: string): string {
  const redirectUri = callbackUrl ?? env.TRIMBLE_CALLBACK_URLS[0];
  const params = new URLSearchParams({
    scope: env.TRIMBLE_SCOPE,
    response_type: "code",
    redirect_uri: redirectUri,
    client_id: env.TRIMBLE_CLIENT_ID,
  });
  if (state) params.set("state", state);
  return `${env.TRIMBLE_AUTHORIZE_URI}?${params}`;
}

// A callback URL is usable only if it is one we were configured with.
export function isConfiguredCallback(url: string | undefined): url is string {
  if (!url) return false;
  const want = url.trim().toLowerCase();
  return getCallbackUrls().some((u) => u.trim().toLowerCase() === want);
}

async function tokenExchange(payload: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(env.TRIMBLE_TOKEN_URI, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(payload),
  });
  if (!res.ok) throw new Error(`Trimble token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function exchangeCode(code: string, redirectUri?: string): Promise<Record<string, unknown>> {
  const callbackUrl = redirectUri ?? env.TRIMBLE_CALLBACK_URLS[0];
  const data = await tokenExchange({
    grant_type: "authorization_code",
    code,
    client_id: env.TRIMBLE_CLIENT_ID,
    client_secret: env.TRIMBLE_CLIENT_SECRET,
    redirect_uri: callbackUrl,
  });
  setManualToken(data.access_token as string, data.refresh_token as string | undefined);
  return data;
}

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshTokenVal) return null;
  const data = await tokenExchange({
    grant_type: "refresh_token",
    refresh_token: refreshTokenVal,
    client_id: env.TRIMBLE_CLIENT_ID,
    client_secret: env.TRIMBLE_CLIENT_SECRET,
    redirect_uri: env.TRIMBLE_CALLBACK_URLS[0],
  });
  accessToken = (data.access_token as string) ?? accessToken;
  refreshTokenVal = (data.refresh_token as string) ?? refreshTokenVal;
  return accessToken;
}

export async function trimbleGet(url: string, params?: Record<string, string>): Promise<unknown> {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const h: Record<string, string> = {};
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  const started = Date.now();

  try {
    let res = await fetch(`${url}${qs}`, { headers: h });
    if (res.status === 401 && refreshTokenVal) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        h.Authorization = `Bearer ${refreshed}`;
        res = await fetch(`${url}${qs}`, { headers: h });
      }
    }
    if (!res.ok) {
      recordEvent({ category: "trimble", level: "error", summary: `GET ${url}`, detail: `${res.status} · ${Date.now() - started}ms` });
      throw new Error(`Trimble GET ${url}: ${res.status}`);
    }
    const json = await res.json();
    recordEvent({ category: "trimble", level: "info", summary: `GET ${url}`, detail: `${res.status} · ${Date.now() - started}ms` });
    return json;
  } catch (e) {
    if (e instanceof Error && !e.message.startsWith("Trimble GET")) {
      recordEvent({ category: "trimble", level: "error", summary: `GET ${url}`, detail: e.message });
    }
    throw e;
  }
}

export async function fetchAllTrimblePages(
  url: string,
  pageSize = 1000,
  extraParams?: Record<string, string>,
): Promise<unknown[]> {
  const MAX_PAGES = 500;
  const all: unknown[] = [];
  let offset = 0;
  let pages = 0;
  while (pages < MAX_PAGES) {
    pages++;
    const params: Record<string, string> = {
      ...extraParams,
      top: String(pageSize),
      offset: String(offset),
    };
    const page = await trimbleGet(url, params);
    let items: unknown[] = [];
    if (Array.isArray(page)) {
      items = page;
    } else if (page && typeof page === "object") {
      const p = page as Record<string, unknown>;
      items = (p.results ?? p.items ?? p.entities ?? []) as unknown[];
    }
    all.push(...items);
    if (items.length < pageSize) return all;
    offset += pageSize;
  }
  logger.warn(`[trimble] fetchAllTrimblePages hit the ${MAX_PAGES}-page ceiling on ${url}; result is truncated`);
  return all;
}

/**
 * Pagination for the Property Set API, which does NOT page the way the Model
 * API does. Per its OpenAPI spec (SwaggerHub Trimble-Connect/pset-prod/v1):
 *
 *   - `top` caps a page at 500 items (default 100), and is only a hint;
 *   - the cursor is an opaque `skiptoken`, echoed back in an absolute `next` url;
 *   - there is no `offset`, no `total`, no `offsetNext`;
 *   - "a list operation can return an empty result set and a `next` if all the
 *     items read for the page were filtered out. Client have to iterate until
 *     `next` property in the response is not present."
 *
 * Sending `offset` to this service is simply ignored, so the loop in
 * fetchAllTrimblePages re-read page 1 until it hit its own page ceiling — which
 * is what produced "values=100000" (500 pages x top=200) from a few hundred
 * real psets. Stopping on a short page is wrong here for the same reason: only
 * the absence of `next` ends the sequence.
 */
export async function fetchAllPsetPages(
  url: string,
  params?: Record<string, string>,
  pageSize = 500,
  // Injectable so the cursor loop can be tested without a network or a token.
  get: (u: string, p?: Record<string, string>) => Promise<unknown> = trimbleGet,
): Promise<unknown[]> {
  // Only a runaway guard; normal termination is `next` going away.
  const MAX_PAGES = 10_000;
  const all: unknown[] = [];
  let nextUrl: string | null = null;
  let pages = 0;

  while (pages < MAX_PAGES) {
    pages++;
    const page = (nextUrl
      ? await get(nextUrl)
      : await get(url, { ...params, top: String(pageSize) })) as Record<string, unknown>;

    const items = Array.isArray(page) ? page : ((page?.items ?? []) as unknown[]);
    all.push(...items);

    const next = typeof page?.next === "string" ? page.next : null;
    if (!next) return all;
    // The spec calls it "the link to the next page"; resolve relative just in case.
    nextUrl = new URL(next, url).toString();
  }

  logger.warn(`[trimble] fetchAllPsetPages hit the ${MAX_PAGES}-page guard on ${url}; result is truncated`);
  return all;
}
