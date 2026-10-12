// The group-preset routes are mounted under /api/admin, outside the Trimble
// router that puts every request on the caller's own Trimble connection. These
// tests drive the real admin app to prove the routes are admin-only and that
// their Trimble calls carry the calling admin's token, not an empty one.
//
// The SQLite store is mocked (same reason as middleware/session.test.ts) and
// fetch is replaced, so this runs with no network and no native module.
//
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

const sessions = new Map<string, { id: string; username: string; expires_at: string }>();

mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    getSession: (id: string) => sessions.get(id) ?? null,
    recordEvent() {},
    getTrimbleRefreshToken: () => null,
    setTrimbleRefreshToken() {},
    createPreviewToken() {},
    consumePreviewToken: () => null,
    listGroupPresets: () => [],
  },
});

mock.module(new URL("./settings.ts", import.meta.url).href, {
  namedExports: {
    isAdmin: (username: string) => username === "alice",
    getRedactedSettings: () => ({}),
    saveSettings() {},
  },
});

let app: import("hono").Hono;
let tc: typeof import("./trimble-client.ts");
const seen: { method: string; url: string; auth: string }[] = [];

before(async () => {
  const { Hono } = await import("hono");
  const { requireSession } = await import("./middleware/session.ts");
  tc = await import("./trimble-client.ts");
  // Mirrors src/index.ts: the app-wide session gate, then the real admin app.
  app = new Hono();
  app.use("/api/*", requireSession);
  app.route("/api/admin", (await import("./routes/admin.ts")).default);

  for (const username of ["alice", "bob"]) {
    sessions.set(`sess-${username}`, { id: `sess-${username}`, username, expires_at: "2999-01-01T00:00:00Z" });
  }
  tc.runAsUser("alice", () => tc.setManualToken("A-ACCESS", null));

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization);
    seen.push({ method: init?.method ?? "GET", url: String(url), auth });
    if (init?.method === "PATCH") return new Response(null, { status: 204 });
    if (String(url).includes("/projects/")) return Response.json({ id: "P1", rootId: "root" });
    return Response.json([{ id: "f1", type: "FOLDER", name: "01-WIP" }]);
  }) as typeof fetch;
});

after(() => mock.reset());

const get = (path: string, user: string) =>
  app.request(path, { headers: { cookie: `session_id=sess-${user}` } });

test("group presets are admin-only", async () => {
  assert.equal((await get("/api/admin/group-presets", "bob")).status, 403);
  assert.equal((await get("/api/admin/group-presets", "alice")).status, 200);
});

test("a preset route reaches Trimble as the calling admin", async () => {
  seen.length = 0;
  const res = await get("/api/admin/group-presets/projects/P1/folders", "alice");
  assert.equal(res.status, 200);
  const folders = (await res.json()) as { path: string }[];
  assert.ok(folders.some((f) => f.path === "01-WIP"));
  assert.ok(seen.length >= 2);
  assert.deepEqual([...new Set(seen.map((s) => s.auth))], ["Bearer A-ACCESS"]);
});

test("PATCH carries the caller's token and accepts an empty 204", async () => {
  seen.length = 0;
  const out = await tc.runAsUser("alice", () => tc.trimblePatch("https://example.test/acl", { acl: {} }));
  assert.equal(out, null);
  assert.deepEqual(seen, [{ method: "PATCH", url: "https://example.test/acl", auth: "Bearer A-ACCESS" }]);
});
