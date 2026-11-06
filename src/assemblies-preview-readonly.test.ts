// The check before a CSV push writes nothing to Produuzit. A design that does not
// exist yet is listed in designs_to_create and only created by /import, which
// needs the token that check issued.
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const writes: string[] = [];
const designs = [{ uuid: "d-1", name: "EL-001", project: PROJECT }];
const batches = [{ uuid: "b-1", name: "1", phase: "F1", project: PROJECT }];
const project: Record<string, any> = { uuid: PROJECT, meta: {} };

mock.module(new URL("./produuzit-client.ts", import.meta.url).href, {
  namedExports: {
    apiGet: async () => structuredClone(project),
    fetchAllPages: async (path: string) =>
      path.includes("assembly_designs") ? structuredClone(designs) : path.includes("batches") ? structuredClone(batches) : [],
    apiPost: async (path: string, body: any) => {
      writes.push(`POST ${path}`);
      const d = { uuid: `d-${designs.length + 1}`, ...body };
      designs.push(d);
      return d;
    },
    apiPatch: async (path: string) => { writes.push(`PATCH ${path}`); return {}; },
    apiPut: async (path: string, body: any) => { writes.push(`PUT ${path}`); Object.assign(project, body); return project; },
  },
});
const tokens = new Map<string, string>();
mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    getBatches: () => [],
    createPreviewToken: (t: string, fp: string, scope: string) => { tokens.set(t, `${fp}|${scope}`); },
    consumePreviewToken: (t: string | undefined, fp: string, scope: string) => {
      if (!t || tokens.get(t) !== `${fp}|${scope}`) return "missing";
      tokens.delete(t);
      return null;
    },
    recordEvent: () => {},
  },
});

const { default: app } = await import("./routes/assemblies.ts");

const body = {
  project_uuid: PROJECT,
  column_mapping: { Element: "design_name", Batch: "batch_number", Aantal: "count" },
  rows: [
    { Element: "EL-001", Batch: "1", Aantal: "2" },
    { Element: "EL-NEW", Batch: "1", Aantal: "3" },
  ],
  include_production_counts: true,
};
const post = (path: string, json: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });

test("check lists the new design, counts it as new, and writes nothing", async () => {
  const res = await post("/preview-import", body);
  const preview = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(writes, []);
  assert.deepEqual(preview.designs_to_create, ["EL-NEW"]);
  const rows = preview.batch_previews[0].rows;
  assert.deepEqual(rows.map((r: any) => [r.design_name, r.status, r.design_new]), [["EL-001", "new", false], ["EL-NEW", "new", true]]);
  assert.ok(preview.preview_token);

  // The confirmed push creates the design, then writes both counts.
  const pushed = await post("/import", { ...body, preview_token: preview.preview_token });
  assert.equal(pushed.status, 200);
  assert.deepEqual(writes, ["POST /constructibles/assembly_designs/", `PUT /company/projects/${PROJECT}/`]);
  assert.deepEqual(project.meta.quantities.assd_batch_counts.map((r: any) => r.count), [2, 3]);
});
