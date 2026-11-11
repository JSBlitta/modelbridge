// Standard libraries are named by uuid (or name, or project number) in a CSV cell.
// A design that lives in a standard library is used from there, never created in
// the project; batch creation links the library, also to a batch that exists.
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const STDLIB = "22222222-2222-4222-8222-222222222222";
const writes: string[] = [];
const designsByProject: Record<string, { uuid: string; name: string }[]> = {
  [PROJECT]: [{ uuid: "d-own", name: "EL-OWN" }],
  [STDLIB]: [{ uuid: "d-lib", name: "STD-01" }, { uuid: "d-lib2", name: "STD-02" }],
};
const batches: Record<string, any>[] = [
  { uuid: "b-1", name: "1", phase: "F1", project: PROJECT, meta: {} },
  { uuid: "b-2", name: "2", phase: "F1", project: PROJECT, meta: { linked_stdlibs: [STDLIB] } },
];
const project: Record<string, any> = { uuid: PROJECT, name: "12654-A", meta: {}, phases: ["F1"] };

mock.module(new URL("./produuzit-client.ts", import.meta.url).href, {
  namedExports: {
    apiGet: async () => structuredClone(project),
    fetchAllPages: async (path: string, params?: Record<string, unknown>) => {
      if (path.includes("standard_libraries")) return [{ uuid: STDLIB, name: "Blitta standaard", project_number: "STD" }];
      if (path.includes("assembly_designs")) return structuredClone(designsByProject[String(params?.project)] ?? []);
      if (path.includes("batches")) return structuredClone(batches);
      if (path.includes("/company/projects/")) return [structuredClone(project)];
      return [];
    },
    apiPost: async (path: string, body: any) => {
      writes.push(body.meta?.linked_stdlibs ? `POST ${path} ${JSON.stringify(body.meta.linked_stdlibs)}` : `POST ${path}`);
      return { uuid: "new", ...body };
    },
    apiPatch: async (path: string, body: any) => { writes.push(`PATCH ${path} ${JSON.stringify(body.meta?.linked_stdlibs ?? null)}`); return {}; },
    apiPut: async (path: string, body: any) => { writes.push(`PUT ${path}`); Object.assign(project, body); return project; },
  },
});
const tokens = new Map<string, string>();
mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    getBatches: () => [],
    upsertBatch: () => {},
    createPreviewToken: (t: string, fp: string, scope: string) => { tokens.set(t, `${fp}|${scope}`); },
    consumePreviewToken: (t: string | undefined, fp: string, scope: string) => {
      if (!t || tokens.get(t) !== `${fp}|${scope}`) return "missing";
      tokens.delete(t);
      return null;
    },
    recordEvent: () => {},
  },
});

const { parseStdlibCell } = await import("./csv-parser.ts");
const { default: assemblies } = await import("./routes/assemblies.ts");
const { default: batchRoutes } = await import("./routes/batches.ts");

const post = (app: any, path: string, json: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });

test("a stdlib cell is a uuid, a list, or JSON", () => {
  assert.deepEqual(parseStdlibCell(STDLIB), [STDLIB]);
  assert.deepEqual(parseStdlibCell(" STD | Blitta standaard "), ["STD", "Blitta standaard"]);
  assert.deepEqual(parseStdlibCell(`["${STDLIB}"]`), [STDLIB]);
  assert.deepEqual(parseStdlibCell(""), []);
});

test("a design named in the row's stdlib (by uuid, hand-mapped column) is used, not created", async () => {
  writes.length = 0;
  const body = {
    project_uuid: PROJECT,
    column_mapping: { Element: "design_name", Batch: "batch_number", Bibliotheek: "stdlib", Aantal: "count" },
    rows: [
      { Element: "STD-01", Batch: "1", Bibliotheek: STDLIB, Aantal: "2" },
      { Element: "EL-OWN", Batch: "1", Bibliotheek: "", Aantal: "1" },
      { Element: "STD-01", Batch: "1", Bibliotheek: "no-such-lib", Aantal: "1" },
    ],
    include_production_counts: true,
  };
  const res = await post(assemblies, "/preview-import", body);
  const preview = await res.json();
  assert.equal(res.status, 200);
  assert.equal(writes.length, 0); // deepEqual would narrow writes to never[]
  assert.deepEqual(preview.designs_from_stdlib, ["STD-01"]);
  // The third row names an unknown library, so its STD-01 is not in the project: listed for creation.
  assert.deepEqual(preview.designs_to_create, ["STD-01"]);
  assert.ok(preview.warnings.some((w: string) => w.includes("no-such-lib")));

  // Push the two resolvable rows: check them first, the token is bound to the rows.
  const p2 = await (await post(assemblies, "/preview-import", { ...body, rows: body.rows.slice(0, 2) })).json();
  assert.deepEqual(p2.designs_to_create, []);
  const ok = await post(assemblies, "/import", { ...body, rows: body.rows.slice(0, 2), preview_token: p2.preview_token });
  assert.equal(ok.status, 200);
  assert.ok(!writes.includes("POST /constructibles/assembly_designs/"), writes.join(", "));
  const counts = project.meta.quantities.assd_batch_counts;
  assert.deepEqual(counts.map((r: any) => r.design).sort(), ["d-lib", "d-own"]);
});

test("a design only in the batch's linked stdlib is found there", async () => {
  writes.length = 0;
  const body = {
    project_uuid: PROJECT,
    column_mapping: { Element: "design_name", Batch: "batch_number" },
    rows: [{ Element: "STD-02", Batch: "2" }],
  };
  const preview = await (await post(assemblies, "/preview-import", body)).json();
  assert.deepEqual(preview.designs_to_create, []);
  assert.deepEqual(preview.designs_from_stdlib, ["STD-02"]);
});

test("creating batches links the stdlib by uuid, also on a batch that already exists", async () => {
  writes.length = 0;
  const res = await post(batchRoutes, "/add-for-projects", {
    phase_defs: [],
    batch_defs: [
      { project_key: "12654-A", project_uuid: PROJECT, batch_number: 1, phase: "F1", stdlibs: [STDLIB] },
      { project_key: "12654-A", project_uuid: PROJECT, batch_number: 3, phase: "F1", stdlibs: ["STD"] },
      { project_key: "12654-A", project_uuid: PROJECT, batch_number: 4, phase: "F1", stdlibs: ["unknown"] },
    ],
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out.map((r: any) => [r.batch_number, r.status]), [["1", "updated_stdlibs"], ["3", "created"], ["4", "error"], ["4", "created"]]);
  assert.ok(writes.includes(`PATCH /constructibles/batches/b-1/ ["${STDLIB}"]`), writes.join(", "));
  // Batch 3 named its library by project number: created with the library's uuid.
  assert.ok(writes.includes(`POST /constructibles/batches/ ["${STDLIB}"]`), writes.join(", "));
});
