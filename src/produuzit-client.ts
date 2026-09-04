import { env } from "./env.js";
import { recordEvent } from "./db.js";

// Service account token state — shared across all requests, not per-user
let serviceRefreshToken: string | null = env.PRODUUZIT_REFRESH_TOKEN || null;
let serviceAccessToken: string | null = null;
let bootstrapped = false;
let refreshPromise: Promise<void> | null = null; // mutex for concurrent refreshes

async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  return res;
}

async function obtainAccessToken(refreshToken: string): Promise<string> {
  console.log("[produuzit] Refreshing access token...");
  const res = await rawFetch(`${env.PRODUUZIT_BASE_URL}/my_user/token/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: refreshToken }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[produuzit] Token refresh failed:", res.status, body);
    recordEvent({ category: "produuzit", level: "error", summary: "Token refresh failed", detail: `${res.status} ${body.slice(0, 300)}` });
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  const data = await res.json() as { access: string; refresh?: string };
  // Handle refresh token rotation — Produuzit may issue a new refresh token
  if (data.refresh && data.refresh !== refreshToken) {
    serviceRefreshToken = data.refresh;
    console.log("[produuzit] New refresh token received (rotation)");
    recordEvent({ category: "produuzit", level: "info", summary: "Refresh token rotated" });
  }
  console.log("[produuzit] Access token refreshed successfully");
  recordEvent({ category: "produuzit", level: "info", summary: "Access token refreshed" });
  return data.access;
}

async function bootstrapFromAdmin(): Promise<void> {
  if (!env.PRODUUZIT_ADMIN_USERNAME || !env.PRODUUZIT_ADMIN_PASSWORD) {
    throw new Error(
      "No Produuzit service token configured.\n" +
      "Set PRODUUZIT_REFRESH_TOKEN in .env, or set PRODUUZIT_ADMIN_USERNAME + PRODUUZIT_ADMIN_PASSWORD + PRODUUZIT_API_ACCOUNT_ID."
    );
  }

  console.log("[produuzit] Bootstrapping service token from admin credentials...");

  // 1. Login as admin to get their access token
  const loginRes = await rawFetch(`${env.PRODUUZIT_BASE_URL}/my_user/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: env.PRODUUZIT_ADMIN_USERNAME, password: env.PRODUUZIT_ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: ${loginRes.status} ${await loginRes.text()}`);
  const { access: adminToken } = await loginRes.json() as { access: string };

  const adminHeaders = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };

  // 2. Resolve account ID — use configured ID or list and pick first
  let accountId = env.PRODUUZIT_API_ACCOUNT_ID;
  if (!accountId) {
    const listRes = await rawFetch(`${env.PRODUUZIT_BASE_URL}/company/api_accounts/`, { headers: adminHeaders });
    if (!listRes.ok) throw new Error(`Failed to list API accounts: ${listRes.status}`);
    const list = await listRes.json() as { results?: { id: number; username: string }[] };
    const accounts = list.results ?? (Array.isArray(list) ? list as { id: number; username: string }[] : []);
    if (!accounts.length) throw new Error("No API accounts found in Produuzit. Create a service account in the Produuzit admin.");
    console.log("[produuzit] Available API accounts:");
    accounts.forEach((a) => console.log(`  id=${a.id} username=${a.username}`));
    accountId = String(accounts[0].id);
    console.log(`[produuzit] Using account id=${accountId}. Set PRODUUZIT_API_ACCOUNT_ID in .env to be explicit.`);
  }

  // 3. Get token for the service account
  const tokenRes = await rawFetch(`${env.PRODUUZIT_BASE_URL}/company/api_accounts/${accountId}/get_token/`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  if (!tokenRes.ok) throw new Error(`get_token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokenData = await tokenRes.json() as Record<string, unknown>;

  console.log("[produuzit] get_token response keys:", Object.keys(tokenData));

  // Extract whatever token fields Produuzit returns
  const refresh = (tokenData.refresh ?? tokenData.refresh_token ?? tokenData.token) as string | undefined;
  const access = (tokenData.access ?? tokenData.access_token) as string | undefined;

  if (refresh) {
    serviceRefreshToken = refresh;
    serviceAccessToken = access ?? null;
    console.log(
      `\n[produuzit] ✓ Service token acquired for account ${accountId}.\n` +
      `Add this to your .env to skip bootstrap on next start:\n` +
      `PRODUUZIT_REFRESH_TOKEN=${refresh}\n`
    );
  } else if (access) {
    // Only got an access token — use it directly (will expire, no refresh)
    serviceAccessToken = access;
    console.log(
      `[produuzit] ⚠ Only got an access token (no refresh). It will expire in ~1h.\n` +
      `Full response: ${JSON.stringify(tokenData)}\n` +
      `Check Produuzit docs for how to get a long-lived token.`
    );
  } else {
    console.log(`[produuzit] get_token full response: ${JSON.stringify(tokenData)}`);
    throw new Error("get_token returned no recognizable token field. See console for full response.");
  }
}

async function ensureServiceToken(): Promise<void> {
  if (serviceAccessToken) return;

  if (!bootstrapped) {
    bootstrapped = true;
    try {
      if (serviceRefreshToken) {
        serviceAccessToken = await obtainAccessToken(serviceRefreshToken);
      } else {
        await bootstrapFromAdmin();
        if (serviceRefreshToken) {
          serviceAccessToken = await obtainAccessToken(serviceRefreshToken);
        }
      }
    } catch (err) {
      bootstrapped = false; // reset so the next request can retry
      throw err;
    }
  }
}

async function refreshService(): Promise<void> {
  // Prevent concurrent refresh calls — if already refreshing, wait for that one
  if (refreshPromise) {
    console.log("[produuzit] Refresh already in progress, waiting...");
    await refreshPromise;
    return;
  }
  if (!serviceRefreshToken) throw new Error("No refresh token to renew with");

  refreshPromise = (async () => {
    try {
      serviceAccessToken = await obtainAccessToken(serviceRefreshToken!);
    } finally {
      refreshPromise = null;
    }
  })();
  await refreshPromise;
}

function serviceHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${serviceAccessToken}`, "Content-Type": "application/json" };
}

async function request(
  method: string,
  path: string,
  opts?: { params?: Record<string, string | number>; json?: unknown; formData?: FormData },
): Promise<unknown> {
  const started = Date.now();
  let failed = false;
  const recordFailure = (detail: string) => {
    failed = true;
    recordEvent({ category: "produuzit", level: "error", summary: `${method} ${path}`, detail });
  };

  try {
    await ensureServiceToken();

    const base = env.PRODUUZIT_BASE_URL;
    let url = `${base}${path}`;
    if (opts?.params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const qstr = qs.toString();
      if (qstr) url += `?${qstr}`;
    }

    const buildInit = (): RequestInit => {
      const h = serviceHeaders();
      const init: RequestInit = { method, headers: h };
      if (opts?.formData) {
        delete (h as Record<string, string>)["Content-Type"];
        init.body = opts.formData;
      } else if (opts?.json !== undefined) {
        init.body = JSON.stringify(opts.json);
      }
      return init;
    };

    let res = await fetch(url, buildInit());
    if (res.status === 401 || res.status === 403) {
      // Token expired or invalid — refresh and retry once
      console.log(`[produuzit] Got ${res.status} on ${method} ${path}, refreshing token...`);
      await refreshService();
      res = await fetch(url, buildInit());
      if (res.status === 401 || res.status === 403) {
        console.error(`[produuzit] Still getting ${res.status} after token refresh on ${method} ${path}`);
      }
    }
    if (!res.ok) {
      const body = await res.text();
      recordFailure(`${res.status} ${body.slice(0, 300)} · ${Date.now() - started}ms`);
      throw new Error(`Produuzit ${method} ${path}: ${res.status} ${body}`);
    }
    const json = await res.json();
    recordEvent({ category: "produuzit", level: "info", summary: `${method} ${path}`, detail: `${res.status} · ${Date.now() - started}ms` });
    return json;
  } catch (e) {
    if (!failed) recordFailure(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export async function apiGet(path: string, params?: Record<string, string | number>): Promise<unknown> {
  return request("GET", path, { params });
}

export async function apiPost(path: string, json?: unknown): Promise<unknown> {
  return request("POST", path, { json });
}

export async function apiPatch(path: string, json?: unknown): Promise<unknown> {
  return request("PATCH", path, { json });
}

export async function apiPut(path: string, json?: unknown): Promise<unknown> {
  return request("PUT", path, { json });
}

export async function apiPostFormData(path: string, formData: FormData): Promise<unknown> {
  return request("POST", path, { formData });
}

export async function fetchAllPages(
  path: string,
  params?: Record<string, string | number>,
  pageSize = 200,
): Promise<unknown[]> {
  const all: unknown[] = [];
  let offset = 0;
  while (true) {
    const res = (await apiGet(path, { ...params, limit: pageSize, offset })) as {
      results?: unknown[];
      next?: string | null;
    };
    const items = res.results ?? [];
    all.push(...items);
    if (!res.next || items.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// Used only by auth route to verify user identity — separate from service token
export async function loginWithCredentials(username: string, password: string): Promise<{ access: string; refresh: string }> {
  const res = await rawFetch(`${env.PRODUUZIT_BASE_URL}/my_user/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<{ access: string; refresh: string }>;
}

export async function fetchMyUser(accessToken: string): Promise<{ username: string; email: string }> {
  const res = await rawFetch(`${env.PRODUUZIT_BASE_URL}/my_user/`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch user profile: ${res.status}`);
  return res.json() as Promise<{ username: string; email: string }>;
}
