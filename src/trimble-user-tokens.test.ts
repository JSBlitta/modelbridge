// Trimble tokens are per ModelBridge user. Before this, two module-level
// variables held one token for the whole process: the last user to connect was
// everyone's Trimble identity, and one user's disconnect logged out all of them.
//
// The SQLite store is mocked (same reason as middleware/session.test.ts) and
// fetch is replaced, so this runs with no network and no native module.
//
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const stored = new Map<string, string>();
const previewTokens = new Map<string, string>();

mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    recordEvent() {},
    getTrimbleRefreshToken: (u: string) => stored.get(u) ?? null,
    setTrimbleRefreshToken: (u: string, t: string | null) => (t ? stored.set(u, t) : stored.delete(u)),
    createPreviewToken: (token: string, fingerprint: string) => previewTokens.set(token, fingerprint),
    // Real contract: null means "matched and consumed".
    consumePreviewToken(token: string, fingerprint: string) {
      if (previewTokens.get(token) !== fingerprint) return "mismatch";
      previewTokens.delete(token);
      return null;
    },
  },
});

const tc = await import("./trimble-client.ts");

test("one user's connection is invisible to another, and disconnect is per user", () => {
  tc.runAsUser("alice", () => tc.setManualToken("A-ACCESS", "A-REFRESH"));
  assert.equal(tc.runAsUser("bob", () => tc.isAuthenticated()), false);
  assert.equal(tc.runAsUser("alice", () => tc.isAuthenticated()), true);
  assert.equal(stored.get("alice"), "A-REFRESH");

  tc.runAsUser("bob", () => tc.clearTokens());
  assert.equal(tc.runAsUser("alice", () => tc.isAuthenticated()), true);
});

test("requests carry the caller's own bearer token", async () => {
  tc.runAsUser("carol", () => tc.setManualToken("C-ACCESS", null));
  tc.runAsUser("dave", () => tc.setManualToken("D-ACCESS", null));
  const seen: string[] = [];
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await Promise.all([
    tc.runAsUser("carol", () => tc.trimbleGet("https://example.test/x")),
    tc.runAsUser("dave", () => tc.trimbleGet("https://example.test/x")),
  ]);
  assert.deepEqual(seen.sort(), ["Bearer C-ACCESS", "Bearer D-ACCESS"]);
});

test("concurrent 401s for one user spend the refresh token once", async () => {
  stored.set("erin", "E-REFRESH-1"); // as if persisted before a restart
  let exchanges = 0;
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    if (String(u).includes("token")) {
      exchanges++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "E-ACCESS-2", refresh_token: "E-REFRESH-2" }), { status: 200 });
    }
    const auth = (init?.headers as Record<string, string>).Authorization;
    return new Response("{}", { status: auth === "Bearer E-ACCESS-2" ? 200 : 401 });
  }) as typeof fetch;
  await Promise.all([1, 2, 3].map(() => tc.runAsUser("erin", () => tc.trimbleGet("https://example.test/y"))));
  assert.equal(exchanges, 1);
  assert.equal(stored.get("erin"), "E-REFRESH-2");
});

test("the OAuth state resolves to the user who started the flow", () => {
  const url = tc.getCallbackUrls()[0];
  const { state } = tc.runAsUser("frank", () => tc.beginOAuth(url));
  assert.deepEqual(tc.redeemOAuthState(state), { redirectUri: url, username: "frank" });
  assert.equal(tc.redeemOAuthState(state), null, "single use");
});
