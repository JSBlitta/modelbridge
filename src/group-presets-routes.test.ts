// The group-preset routes, driven through the real admin app against a fake
// Trimble that keeps state: groups, members and folder permissions change when
// written to, so a second run sees what the first one did.
//
// What is proven here is what makes an apply safe to offer: it needs a check,
// it refuses a project that changed after the check, it writes nothing from a
// read that failed, it only adds, and running it twice changes nothing.
//
// The SQLite store is mocked (same reason as middleware/session.test.ts) and
// fetch is replaced, so this runs with no network and no native module.
//
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const sessions = new Map<string, { id: string; username: string; expires_at: string }>();
const tokens = new Map<string, string>();

mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    getSession: (id: string) => sessions.get(id) ?? null,
    recordEvent() {},
    getTrimbleRefreshToken: () => null,
    setTrimbleRefreshToken() {},
    listGroupPresets: () => [],
    getGroupPreset: () => null,
    // The import page's project route caches; here nothing is cached yet.
    getTrimbleCache: () => null,
    setTrimbleCache() {},
    upsertTrimbleProjects() {},
    createPreviewToken: (token: string, fingerprint: string) => tokens.set(token, fingerprint),
    // Real contract: single use, null means "matched and consumed".
    consumePreviewToken(token: string | undefined, fingerprint: string) {
      if (!token) return "missing";
      const stored = tokens.get(token);
      if (stored === undefined) return "unknown";
      tokens.delete(token);
      return stored === fingerprint ? null : "mismatch";
    },
  },
});

mock.module(new URL("./settings.ts", import.meta.url).href, {
  namedExports: {
    isAdmin: (username: string) => username !== "bob",
    getSettings: () => ({}),
    getStoredRefreshToken: () => "",
    storeRefreshToken() {},
    getRedactedSettings: () => ({}),
    saveSettings() {},
  },
});

// --- A Trimble project that remembers ---------------------------------------

type AclBody = { acl: Record<string, string[]>; inheritance?: boolean };

let trimble: {
  users: { id: string; email: string; role: string; status: string }[];
  groups: { id: string; name: string; users: string[] }[];
  acl: Record<string, AclBody>; // folder id -> permissions set on it; absent = 404
  pageSize: number; // members per page; 0 = all at once
  dropPatch: boolean; // accept a permissions write, keep nothing
  fail: (method: string, path: string) => number | undefined;
};
const seen: { method: string; path: string; auth: string }[] = [];
const writes = () => seen.filter((s) => s.method !== "GET");

function reset() {
  seen.length = 0;
  trimble = {
    users: [
      { id: "a1", email: "alice@x.nl", role: "ADMIN", status: "ACTIVE" },
      { id: "u1", email: "ann@x.nl", role: "USER", status: "ACTIVE" },
    ],
    groups: [],
    acl: { f1: { acl: { READ: ["users:old"] }, inheritance: false } },
    pageSize: 0,
    dropPatch: false,
    fail: () => undefined,
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function fakeTrimble(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^.*\/tc\/api\/2\.0\//, "") + url.search;
  const method = init?.method ?? "GET";
  const headers = (init?.headers ?? {}) as Record<string, string>;
  seen.push({ method, path, auth: String(headers.Authorization) });
  // Trimble's sign-in hands out a token named after the code it was given.
  if (url.hostname === "id.trimble.com") return json({ access_token: `T-${new URLSearchParams(String(init?.body)).get("code")}` });
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  const failed = trimble.fail(method, path);
  if (failed) return new Response("boom", { status: failed });

  let m: RegExpMatchArray | null;
  if (path.startsWith("projects?")) return json([{ id: "P1", name: "Proj" }]);
  if (path === "users/me") return json({ id: "a1", email: "alice@x.nl" });
  if (path === "projects/P1") return json({ id: "P1", rootId: "root", name: "Proj" });

  if (path.startsWith("projects/P1/users")) {
    if (method === "POST") {
      // Someone new to Trimble: the answer carries no id.
      trimble.users.push({ id: `u-${body.email}`, email: body.email, role: body.role, status: "PENDING" });
      return json({ email: body.email, role: body.role, status: "PENDING" });
    }
    const size = trimble.pageSize || trimble.users.length;
    const start = Number(/items=(\d+)-/.exec(headers.Range ?? "")?.[1] ?? 0);
    if (start >= trimble.users.length) return new Response(null, { status: 416 });
    return json(trimble.users.slice(start, start + size), 206);
  }

  if (path.startsWith("groups?")) return json(trimble.groups.map(({ id, name }) => ({ id, name })));
  if (path === "groups" && method === "POST") {
    trimble.groups.push({ id: `g${trimble.groups.length + 1}`, name: body.name, users: [] });
    return new Response(null, { status: 201 }); // the id has to come from the list
  }
  if ((m = path.match(/^groups\/([^/]+)\/users$/))) {
    const group = trimble.groups.find((g) => g.id === m![1])!;
    if (method === "POST") group.users.push(...(body as { id: string }[]).map((u) => u.id));
    return json(group.users.map((id) => ({ id })));
  }

  if ((m = path.match(/^folders\/fs\/([^/]+)\/permissions$/))) {
    if (method === "PATCH") {
      if (!trimble.dropPatch) trimble.acl[m[1]] = body;
      return new Response(null, { status: 204 });
    }
    return trimble.acl[m[1]] ? json(trimble.acl[m[1]]) : new Response(null, { status: 404 });
  }
  if (path === "folders/root/items") return json([{ id: "f1", type: "FOLDER", name: "01-WIP" }]);
  if (/^folders\/[^/]+\/items$/.test(path)) return json([]);
  return new Response("unexpected call in test", { status: 500 });
}

// --- The app -----------------------------------------------------------------

let app: import("hono").Hono;
let tc: typeof import("./trimble-client.ts");

before(async () => {
  const { Hono } = await import("hono");
  const { requireSession } = await import("./middleware/session.ts");
  tc = await import("./trimble-client.ts");
  // Mirrors src/index.ts: the app-wide session gate, then the real admin app.
  app = new Hono();
  app.use("/api/*", requireSession);
  app.route("/api/trimble", (await import("./routes/trimble.ts")).default);
  app.route("/api/admin", (await import("./routes/admin.ts")).default);

  for (const username of ["alice", "bob", "carol", "dave"]) {
    sessions.set(`sess-${username}`, { id: `sess-${username}`, username, expires_at: "2999-01-01T00:00:00Z" });
  }
  tc.runAsUser("alice", () => tc.setManualToken("A-ACCESS", null));
  globalThis.fetch = fakeTrimble as typeof fetch;
});

beforeEach(reset);
after(() => mock.reset());

const BASE = "/api/admin/group-presets";
const get = (path: string, user: string) => app.request(path, { headers: { cookie: `session_id=sess-${user}` } });

// One group, one member already in the project, one stranger, one folder.
const PRESET = {
  name: "T",
  groups: [
    {
      name: "Steel",
      members: [{ email: "ann@x.nl" }, { email: "new@x.nl" }],
      rules: [{ pattern: "01-WIP", level: "FULL_ACCESS" }],
    },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await app.request(BASE + path, {
    method: "POST",
    headers: { cookie: "session_id=sess-alice", "content-type": "application/json" },
    body: JSON.stringify({ project_id: "P1", preset: PRESET, ...body }),
  });
  return { status: res.status, body: await res.json() };
}
const check = () => post("/preview", {});
const apply = (preview_token?: string, extra = {}) => post("/apply", { preview_token, ...extra });

// --- Access ------------------------------------------------------------------

test("group presets are admin-only", async () => {
  assert.equal((await get(BASE, "bob")).status, 403);
  assert.equal((await get(BASE, "alice")).status, 200);
});

test("a preset route reaches Trimble as the calling admin", async () => {
  const res = await get(`${BASE}/projects/P1/folders`, "alice");
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { path: string }[]).map((f) => f.path), ["01-WIP"]);
  assert.ok(seen.length >= 2);
  assert.deepEqual([...new Set(seen.map((s) => s.auth))], ["Bearer A-ACCESS"]);
});

test("a write carries the caller's token and accepts an empty answer", async () => {
  const out = await tc.runAsUser("alice", () =>
    tc.trimblePatch("https://example.test/tc/api/2.0/folders/fs/f1/permissions", { acl: {} }),
  );
  assert.equal(out, null);
  assert.deepEqual(seen, [{ method: "PATCH", path: "folders/fs/f1/permissions", auth: "Bearer A-ACCESS" }]);
});

// --- One Trimble connection for both pages ----------------------------------

// The OAuth round trip as the browser makes it: start on a page, come back from
// Trimble without a session cookie. Returns where the browser is sent next.
async function connect(user: string, code: string, page?: string): Promise<string | null> {
  const start = await get(`/api/trimble/auth/start${page ? `?return=${encodeURIComponent(page)}` : ""}`, user);
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state");
  const back = await app.request(`/api/trimble/auth/callback?code=${code}&state=${state}`);
  assert.equal(back.status, 302);
  return back.headers.get("location");
}

test("a connection made on the import page serves the group-preset check", async () => {
  assert.equal(await connect("carol", "C1"), "/trimble?auth=success");
  const res = await app.request(BASE + "/preview", {
    method: "POST",
    headers: { cookie: "session_id=sess-carol", "content-type": "application/json" },
    body: JSON.stringify({ project_id: "P1", preset: PRESET }),
  });
  assert.equal(res.status, 200);
  const calls = seen.filter((s) => s.path !== "/oauth/token");
  assert.ok(calls.length > 3);
  assert.deepEqual([...new Set(calls.map((s) => s.auth))], ["Bearer T-C1"]);
});

test("a connection made on the admin page returns there and serves the import page", async () => {
  assert.equal(await connect("dave", "D1", "admin"), "/admin?tab=groups&auth=success");
  assert.deepEqual(await (await get("/api/trimble/auth/status", "dave")).json(), { authenticated: true });
  seen.length = 0;
  assert.equal((await get("/api/trimble/projects", "dave")).status, 200);
  assert.deepEqual(seen.map((s) => s.auth), ["Bearer T-D1"]);
});

test("the callback sends the browser only to a page it knows", async () => {
  for (const page of ["https://evil.example/", "//evil.example", "__proto__", "constructor", ""]) {
    assert.equal(await connect("dave", "D2", page), "/trimble?auth=success", page);
  }
});

// --- The check gates the apply -------------------------------------------------

test("an apply without the token of a check writes nothing", async () => {
  assert.equal((await apply()).status, 409);
  assert.equal((await apply("made-up")).status, 409);
  assert.deepEqual(writes(), []);
});

test("check, apply, and a second run that changes nothing", async () => {
  const plan = (await check()).body;
  // create group + add ann + invite new + new joins + one folder
  assert.equal(plan.changes, 5);
  assert.deepEqual(plan.invites, ["new@x.nl"]);
  assert.deepEqual(plan.groups[0].members.map((m: { action: string }) => m.action), ["add", "invite"]);
  assert.deepEqual(writes(), [], "a check only reads");

  // replace_acl was an option once. It must not do anything now.
  const done = await apply(plan.preview_token, { replace_acl: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  assert.deepEqual(done.body.groups[0].invited, ["new@x.nl"]);
  assert.deepEqual(done.body.groups[0].added, ["ann@x.nl", "new@x.nl"]);

  // The stranger had no id in the invitation's answer and is in the group anyway.
  assert.deepEqual(trimble.groups, [{ id: "g1", name: "Steel", users: ["u1", "u-new@x.nl"] }]);
  // The grant that was there is kept; the new one names the group the way Trimble does.
  assert.deepEqual(trimble.acl.f1, { acl: { READ: ["users:old"], FULL_ACCESS: ["tc-groups:g1"] }, inheritance: false });

  // A token is good for one apply.
  assert.equal((await apply(plan.preview_token)).status, 409);

  seen.length = 0;
  const again = (await check()).body;
  assert.equal(again.changes, 0);
  assert.deepEqual(again.invites, []);
  const noop = await apply(again.preview_token);
  assert.equal(noop.body.ok, true);
  assert.equal(noop.body.writes, 0);
  assert.deepEqual(writes(), []);
});

test("a project that changed after the check is not written to", async () => {
  const plan = (await check()).body;
  trimble.acl.f1.acl.READ.push("users:someone-else");
  assert.equal((await apply(plan.preview_token)).status, 409);
  assert.deepEqual(writes(), []);
});

// --- Nothing is written from a guess -------------------------------------------

test("a read that fails stops the check, and an apply in that state writes nothing", async () => {
  trimble.groups = [{ id: "g9", name: "Steel", users: [] }];
  for (const broken of ["folders/root/items", "folders/fs/f1/permissions", "groups/g9/users", "projects/P1/users"]) {
    seen.length = 0;
    trimble.fail = (method, path) => (method === "GET" && path.startsWith(broken) ? 500 : undefined);
    assert.equal((await check()).status, 502, broken);
    assert.equal((await apply("made-up")).status, 502, broken);
    assert.deepEqual(writes(), [], broken);
  }
});

test("a folder without permissions of its own gets the grant alone", async () => {
  delete trimble.acl.f1; // Trimble answers 404
  const plan = (await check()).body;
  assert.equal((await apply(plan.preview_token)).body.ok, true);
  assert.deepEqual(trimble.acl.f1, { acl: { FULL_ACCESS: ["tc-groups:g1"] } });
});

test("a write Trimble accepted but did not keep is reported", async () => {
  trimble.dropPatch = true;
  const done = (await apply((await check()).body.preview_token)).body;
  assert.equal(done.ok, false);
  assert.equal(done.folders[0].ok, false);
  assert.match(done.folders[0].error, /read back/);
});

test("a member on a later page of the member list is not invited again", async () => {
  trimble.pageSize = 1; // alice on page one, ann on page two
  const plan = (await check()).body;
  assert.deepEqual(plan.invites, ["new@x.nl"]);
  assert.equal(plan.groups[0].members[0].action, "add");
});

test("a caller who is not admin in the Trimble project cannot apply", async () => {
  trimble.users[0].role = "USER";
  const plan = (await check()).body;
  assert.deepEqual(plan.blockers, [{ code: "not_project_admin", detail: "USER" }]);
  assert.equal(plan.preview_token, undefined);
  assert.equal((await apply("made-up")).status, 409);
  assert.deepEqual(writes(), []);
});

test("a preset cannot name one group twice", async () => {
  const res = await app.request(BASE, {
    method: "POST",
    headers: { cookie: "session_id=sess-alice", "content-type": "application/json" },
    body: JSON.stringify({ name: "D", groups: [{ name: "Steel" }, { name: " steel " }] }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /unique/);
});
