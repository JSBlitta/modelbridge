// Server-side session gate.
//
// ModelBridge holds a single company-wide Produuzit service token. Produuzit
// cannot tell our users apart (there are only three API accounts and this app
// owns one), so the *only* place a per-user boundary can exist is here. Before
// this middleware existed the sole gate was a client-side redirect in
// frontend/src/router/index.js, which any direct HTTP call bypassed.
//
// Everything under /api is gated except the handful of paths below, which must
// work before a session exists.

import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import * as db from "../db.js";
import { isAdmin } from "../settings.js";

export const SESSION_COOKIE = "session_id";

// Exact paths reachable without a session. Matched exactly, never by prefix —
// "/api/health" being public must not make "/api/health/config" public too.
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  // The Trimble OAuth provider redirects the browser here from id.trimble.com.
  // That is a cross-site top-level navigation, so a SameSite=Strict session
  // cookie is deliberately NOT sent — the callback cannot be session-gated and
  // is protected by the `state` parameter instead (see trimble-client.ts).
  "/api/trimble/auth/callback",
]);

declare module "hono" {
  interface ContextVariableMap {
    session: db.SessionRow;
  }
}

export const requireSession: MiddlewareHandler = async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();

  const sessionId = getCookie(c, SESSION_COOKIE);
  const session = sessionId ? db.getSession(sessionId) : null;
  if (!session) {
    return c.json({ error: "Not authenticated", code: "UNAUTHENTICATED" }, 401);
  }

  c.set("session", session);
  await next();
};

// Admin gate, layered on top of requireSession. Kept separate so /api/admin can
// mount it without duplicating the session lookup.
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const session = c.get("session");
  if (!session || !isAdmin(session.username)) {
    return c.json({ error: "Admin access required" }, 403);
  }
  await next();
};

// Cookies must carry Secure whenever the browser reached us over HTTPS. Behind
// IIS the Node process itself sees plain HTTP, so the forwarded header is the
// authoritative signal. COOKIE_SECURE=true forces it on for deployments where
// the header is stripped.
export function isSecureRequest(c: Context): boolean {
  if ((process.env.COOKIE_SECURE ?? "").toLowerCase() === "true") return true;
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim().toLowerCase() === "https";
  return new URL(c.req.url).protocol === "https:";
}
