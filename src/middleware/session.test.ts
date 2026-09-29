// Drives the real session and admin middleware over real HTTP requests.
//
// better-sqlite3 has no prebuilt binary for this machine and there is no C++
// toolchain to build one, so the SQLite-backed session lookup is mocked. Every
// other layer is genuine: the real Hono app, the real requireSession and
// requireAdmin handlers, real cookies, real status codes.
//
// Run: npm run test:middleware   (needs --experimental-test-module-mocks)

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

type SessionRow = {
  id: string; username: string; email: string; created_at: string; expires_at: string;
};

const sessions = new Map<string, SessionRow>();
let adminUsernames: string[] = [];

// Stand in for the SQLite session store. getSession keeps the real expiry
// semantics — an expired row is treated as absent.
mock.module(new URL("../db.ts", import.meta.url).href, {
  namedExports: {
    getSession(id: string): SessionRow | null {
      const row = sessions.get(id);
      if (!row) return null;
      if (new Date(row.expires_at) < new Date()) {
        sessions.delete(id);
        return null;
      }
      return row;
    },
    recordEvent() {},
  },
});

mock.module(new URL("../settings.ts", import.meta.url).href, {
  namedExports: {
    isAdmin(username: string) {
      const u = (username ?? "").trim().toLowerCase();
      return adminUsernames.some((a) => a.trim().toLowerCase() === u);
    },
  },
});

let app: import("hono").Hono;

before(async () => {
  const { Hono } = await import("hono");
  const { requireSession, requireAdmin } = await import("./session.ts");

  // Mirrors how src/index.ts mounts things: one app-wide session gate, with the
  // admin gate layered on top of /api/admin only.
  app = new Hono();
  app.use("/api/*", requireSession);
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/health/config", (c) => c.json({ secret: "leaked-if-reachable" }));
  app.get("/api/projects", (c) => c.json({ ok: true }));
  app.get("/api/config/synonyms", (c) => c.json({ ok: true }));
  app.use("/api/admin/*", requireAdmin);
  app.get("/api/admin/settings", (c) => c.json({ ok: true }));
});

after(() => mock.reset());

function seedSession(username: string, ttlMs = 3600_000): string {
  const id = `sess-${username}-${Math.random().toString(36).slice(2)}`;
  sessions.set(id, {
    id, username, email: `${username}@example.test`,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  return id;
}

const get = (path: string, sessionId?: string) =>
  app.request(path, { headers: sessionId ? { cookie: `session_id=${sessionId}` } : {} });

// --- unauthenticated -------------------------------------------------------

test("only /api/health is reachable without a session", async () => {
  const res = await get("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("/api/health/config is NOT public just because /api/health is", async () => {
  // The prefix trap: this endpoint names the bootstrap admin account.
  assert.equal((await get("/api/health/config")).status, 401);
});

test("data routes are refused without a session", async () => {
  for (const path of ["/api/projects", "/api/config/synonyms", "/api/admin/settings"]) {
    const res = await get(path);
    assert.equal(res.status, 401, `${path} must be 401`);
    assert.equal((await res.json() as { code: string }).code, "UNAUTHENTICATED");
  }
});

test("an unknown session id is refused", async () => {
  assert.equal((await get("/api/projects", "not-a-real-session")).status, 401);
});

test("an expired session is refused", async () => {
  const id = seedSession("alice", -1000);
  assert.equal((await get("/api/projects", id)).status, 401);
});

// --- authenticated ---------------------------------------------------------

test("a valid session reaches the data routes", async () => {
  const id = seedSession("alice");
  assert.equal((await get("/api/projects", id)).status, 200);
  assert.equal((await get("/api/health/config", id)).status, 200);
});

// --- the admin claim under test --------------------------------------------

test("with ADMIN_USERNAMES empty, a logged-in user gets 403 from the admin page", async () => {
  // This is the failure mode setup.bat now warns about: leave ADMIN_USERNAMES
  // blank and nobody can open the admin page, including the person who set the
  // app up. Asserted here rather than assumed.
  adminUsernames = [];
  const id = seedSession("alice");

  const res = await get("/api/admin/settings", id);
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: string }).error, "Admin access required");

  // ...while the same session still works everywhere else.
  assert.equal((await get("/api/projects", id)).status, 200);
});

test("naming the user in ADMIN_USERNAMES opens the admin page", async () => {
  adminUsernames = ["alice"];
  const id = seedSession("alice");
  assert.equal((await get("/api/admin/settings", id)).status, 200);
});

test("admin matching ignores case and surrounding whitespace", async () => {
  adminUsernames = ["  ALICE  "];
  const id = seedSession("alice");
  assert.equal((await get("/api/admin/settings", id)).status, 200);
});

test("a different logged-in user is still refused the admin page", async () => {
  adminUsernames = ["alice"];
  const id = seedSession("bob");
  assert.equal((await get("/api/admin/settings", id)).status, 403);
});
