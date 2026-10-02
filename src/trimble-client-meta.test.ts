// Trimble preview and push, over the real route: one preview row per element,
// and client_meta written per key only where Produuzit has none.
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A fake Produuzit: one design, one batch, three constructibles of that design.
const project = { phases: ["F1"], meta: { quantities: { assd_batch_counts: [{ batch: "b1", phase: "F1", design: "d1", count: 3 }] } } };
let assemblies: Record<string, any>[] = [];
const patches: { path: string; body: Record<string, any> }[] = [];
const puts: unknown[] = [];

mock.module(new URL("./produuzit-client.ts", import.meta.url).href, {
  namedExports: {
    apiGet: async () => structuredClone(project),
    apiPost: async () => ({}),
    apiPut: async (_p: string, body: unknown) => { puts.push(body); },
    apiPatch: async (path: string, body: Record<string, any>) => {
      patches.push({ path, body });
      const a = assemblies.find((x) => path.includes(x.uuid))!;
      Object.assign(a, structuredClone(body)); // worst case: PATCH replaces client_meta wholesale
      return a;
    },
    fetchAllPages: async (path: string) => {
      if (path.includes("assembly_designs")) return [{ uuid: "d1", name: "EL001" }];
      if (path.includes("batches")) return [{ uuid: "b1", name: "1", phase: "F1" }];
      return structuredClone(assemblies);
    },
  },
});

// better-sqlite3 cannot be built here; the gate and the batch states are faked.
mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    recordEvent() {},
    createPreviewToken() {},
    consumePreviewToken: () => null,
    getTrimbleRefreshToken: () => null,
    setTrimbleRefreshToken() {},
    getBatches: () => [],
  },
});

const { default: app } = await import("./routes/trimble.ts");

const element = (order: string, gevel: string) => ({ psets: { X: { design: "EL001", batch: "1", order, gevel } } });
const body = (entities: unknown[]) => ({
  project_uuid: "p1",
  entities,
  column_mapping: {
    "psets.X.design": "design_name",
    "psets.X.batch": "batch_number",
    "psets.X.order": ["client_order_id", "client_meta.uid_element"],
    "psets.X.gevel": "client_meta.gevel",
  },
});
const post = async (path: string, json: unknown) => {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, any>;
};
const selection = [element("K-1", "Z"), element("K-2", "O"), element("K-3", "W")];

test("preview lists every element, and compares client_meta per key without overwriting", async () => {
  assemblies = [
    { uuid: "a1", batch: "b1", design: "d1", client_order_id: "K-1", client_meta: { gevel: "N", other: "keep" } },
    { uuid: "a2", batch: "b1", design: "d1", client_order_id: "K-2", client_meta: null },
    { uuid: "a3", batch: "b1", design: "d1", client_order_id: null },
  ];
  const [bp] = (await post("/preview-import", body(selection))).batch_previews;

  // Three elements of one design: three rows, not one row with count 3.
  assert.deepEqual(bp.rows.map((r: any) => [r.client_order_id, r.count, r.count_requested, r.status]),
    [["K-1", 1, 3, "identical"], ["K-2", 1, 3, "identical"], ["K-3", 1, 3, "identical"]]);
  assert.deepEqual(bp.summary, { total: 3, new: 0, kept: 0, identical: 3, blocked: 0 });

  const meta = Object.fromEntries(bp.order_rows.map((r: any) => [r.order, r.meta.map((m: any) => `${m.key}:${m.status}`).join(",")]));
  assert.deepEqual(meta, {
    "K-1": "uid_element:add,gevel:differs", // Produuzit already says gevel N
    "K-2": "uid_element:add,gevel:add",
    "K-3": "uid_element:add,gevel:add",
  });
  assert.equal(bp.order_rows.find((r: any) => r.order === "K-1").meta[1].existing, "N");
  assert.deepEqual(bp.order_summary, { assign: 1, identical: 2, other: 0, no_constructible: 0, meta_add: 5, meta_differs: 1 });
  assert.ok(bp.order_rows.every((r: any) => !("meta_write" in r)));
});

test("push adds the missing keys, keeps every existing value, and a repeat run writes nothing", async () => {
  patches.length = 0;
  const first = await post("/import", body(selection));
  assert.deepEqual(patches.map((p) => [p.path.split("/").at(-2), p.body]), [
    ["a1", { client_meta: { gevel: "N", other: "keep", uid_element: "K-1" } }],
    ["a2", { client_meta: { uid_element: "K-2", gevel: "O" } }],
    ["a3", { client_order_id: "K-3", client_meta: { uid_element: "K-3", gevel: "W" } }],
  ]);
  assert.equal(first.summary.updated, 3);
  assert.equal(first.summary.error, 0);
  assert.ok(first.results.some((r: any) => r.status === "skipped" && /client_meta\.gevel is already "N"/.test(r.reason)));
  assert.equal(puts.length, 0, "production counts were not requested");

  patches.length = 0;
  await post("/import", body(selection));
  assert.equal(patches.length, 0, "second run must not PATCH anything");
});

test("client_meta without a client order ID cannot be tied to a constructible and is reported", async () => {
  const preview = await post("/preview-import", body([...selection, element("", "Z")]));
  assert.equal(preview.client_meta_unattributed, 1);
});
