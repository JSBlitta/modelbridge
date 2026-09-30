// Production counts are write-once: set where Produuzit has none, never changed
// after that, and a run with nothing new makes no write at all.
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A fake Produuzit project; apiPut records every write.
let project: Record<string, any> = {};
const puts: Record<string, any>[] = [];
mock.module(new URL("./produuzit-client.ts", import.meta.url).href, {
  namedExports: {
    apiGet: async () => structuredClone(project),
    apiPut: async (_path: string, body: Record<string, any>) => { puts.push(body); project = structuredClone(body); },
  },
});

const { previewCountRow, summarizeCountRows, upsertProductionCounts } = await import("./lib/production-counts.ts");

test("preview: missing is new, same is identical, different is kept, definitive is blocked", () => {
  assert.equal(previewCountRow(0, 4, false).status, "new");
  assert.equal(previewCountRow(4, 4, false).status, "identical");
  assert.equal(previewCountRow(5, 3, false).status, "kept");
  assert.equal(previewCountRow(2, 6, false).status, "kept");
  assert.equal(previewCountRow(0, 4, true).status, "blocked");
  const rows = [previewCountRow(0, 1, false), previewCountRow(5, 3, false), previewCountRow(2, 2, false)];
  assert.deepEqual(summarizeCountRows(rows), { total: 6, new: 1, kept: 1, identical: 1, blocked: 0 });
});

test("upsert writes only missing counts, and a repeat run writes nothing", async () => {
  project = { meta: { quantities: { assd_batch_counts: [{ batch: "B", phase: "P", design: "EL001", count: 5 }] } } };
  const entries = [
    { batch: "B", phase: "P", design: "EL001", count: 4 }, // exists as 5: must stay 5
    { batch: "B", phase: "P", design: "EL002", count: 2 }, // missing: written
  ];

  const first = await upsertProductionCounts("proj", entries);
  assert.deepEqual(first.written.map((e) => e.design), ["EL002"]);
  assert.deepEqual(first.kept.map((e) => [e.design, e.existing]), [["EL001", 5]]);
  assert.equal(puts.length, 1);
  const rows = project.meta.quantities.assd_batch_counts;
  assert.deepEqual(rows.map((r: any) => [r.design, r.count]), [["EL001", 5], ["EL002", 2]]);

  const second = await upsertProductionCounts("proj", entries);
  assert.equal(second.written.length, 0);
  assert.equal(puts.length, 1, "second run must not PUT the project");
});
