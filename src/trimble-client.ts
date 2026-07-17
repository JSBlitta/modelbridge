import { createServer, type Server } from "node:net";
import { env } from "./env.js";

let accessToken: string | null = null;
let refreshTokenVal: string | null = null;

// --- Temporary OAuth callback server (port 80) ---

interface OAuthServerState {
  server: Server | null;
  port: number;
  completed: boolean;
  error: string | null;
  completedAt: string | null;
}

const oauthState: OAuthServerState = {
  server: null,
  port: 0,
  completed: false,
  error: null,
  completedAt: null,
};

export const OAUTH_CALLBACK_PORT = 80;

export function getOAuthState() {
  return {
    server_running: oauthState.server?.listening ?? false,
    port: oauthState.port,
    completed: oauthState.completed,
    error: oauthState.error,
    completed_at: oauthState.completedAt,
    authenticated: isAuthenticated(),
  };
}

export function stopOAuthServer(): void {
  if (oauthState.server) {
    oauthState.server.close();
    oauthState.server = null;
    oauthState.port = 0;
  }
}

export function markOAuthCompleted(error?: string | null): void {
  oauthState.completed = true;
  oauthState.error = error ?? null;
  oauthState.completedAt = new Date().toISOString();
}

export async function startOAuthServer(): Promise<number> {
  stopOAuthServer();
  oauthState.completed = false;
  oauthState.error = null;
  oauthState.completedAt = null;

  return new Promise((resolve, reject) => {
    const server = createServer(async (socket) => {
      let raw = "";
      socket.on("data", (chunk) => { raw += chunk.toString(); });
      socket.on("end", async () => {
        const requestLine = raw.split("\r\n")[0] ?? "";
        const parts = requestLine.split(" ");
        const path = parts[1] ?? "/";
        const url = new URL(`http://localhost${path}`);
        const code = url.searchParams.get("code");

        if (code) {
          let responseBody: string;
          try {
            await exchangeCode(code, "http://localhost");
            oauthState.completed = true;
            oauthState.error = null;
            oauthState.completedAt = new Date().toISOString();
            responseBody = `<html><body style="font-family:sans-serif;text-align:center;padding-top:3rem">
              <h2 style="color:#166534">&#10003; Authentication successful</h2>
              <p>You may close this window and return to the application.</p>
              <script>setTimeout(()=>window.close(),2000)</script>
            </body></html>`;
          } catch (e) {
            oauthState.error = String(e);
            oauthState.completed = true;
            oauthState.completedAt = new Date().toISOString();
            responseBody = `<html><body style="font-family:sans-serif;text-align:center;padding-top:3rem">
              <h2 style="color:#b91c1c">&#10007; Authentication failed</h2>
              <p>${String(e)}</p>
            </body></html>`;
          }
          const response = [
            `HTTP/1.1 200 OK`,
            `Content-Type: text/html; charset=utf-8`,
            `Content-Length: ${Buffer.byteLength(responseBody)}`,
            `Connection: close`,
            ``,
            responseBody,
          ].join("\r\n");
          socket.write(response);
          socket.end();
          stopOAuthServer();
        } else {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nMissing code");
          socket.end();
        }
      });
    });

    server.on("error", (e) => reject(e));
    server.listen(OAUTH_CALLBACK_PORT, "localhost", () => {
      oauthState.server = server;
      oauthState.port = OAUTH_CALLBACK_PORT;
      resolve(OAUTH_CALLBACK_PORT);
    });
  });
}

const REGION_ENDPOINTS = {
  Core: "https://app21.connect.trimble.com/tc/api/2.0/",
  Model: "https://model-api21.connect.trimble.com/",
  Organizer: "https://org-api.eu-west-1.connect.trimble.com/v1/",
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

export function buildAuthorizeUrl(callbackUrl?: string): string {
  const redirectUri = callbackUrl ?? env.TRIMBLE_CALLBACK_URLS[0];
  const params = new URLSearchParams({
    scope: env.TRIMBLE_SCOPE,
    response_type: "code",
    redirect_uri: redirectUri,
    client_id: env.TRIMBLE_CLIENT_ID,
  });
  return `${env.TRIMBLE_AUTHORIZE_URI}?${params}`;
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

  let res = await fetch(`${url}${qs}`, { headers: h });
  if (res.status === 401 && refreshTokenVal) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      h.Authorization = `Bearer ${refreshed}`;
      res = await fetch(`${url}${qs}`, { headers: h });
    }
  }
  if (!res.ok) throw new Error(`Trimble GET ${url}: ${res.status}`);
  return res.json();
}

export async function fetchAllTrimblePages(
  url: string,
  pageSize = 1000,
  extraParams?: Record<string, string>,
): Promise<unknown[]> {
  const all: unknown[] = [];
  let offset = 0;
  while (true) {
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
    if (items.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
