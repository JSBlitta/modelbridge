// The import overwrites Produuzit's production count; the preview must say so.
// Run: npm run test:node   (needs --experimental-test-module-mocks)

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// production-counts.ts talks to Produuzit; only its pure helpers are tested here.
mock.module(new URL("./produuzit-client.ts", import.meta.url).href, {
  namedExports: { apiGet() {}, apiPut() {} },
});

const { previewCountRow, summarizeCountRows } = await import("./lib/production-counts.ts");

test("a smaller selection is a lowering change, not 'identical'", () => {
  assert.deepEqual(previewCountRow(5, 3, false), { count_requested: 3, count_existing: 5, lowers: true, status: "changed" });
});

test("same number is identical, first write is new, higher is a plain change", () => {
  assert.equal(previewCountRow(4, 4, false).status, "identical");
  assert.equal(previewCountRow(0, 2, false).status, "new");
  assert.deepEqual(previewCountRow(2, 6, false), { count_requested: 6, count_existing: 2, lowers: false, status: "changed" });
});

test("definitive batches are blocked whatever the numbers", () => {
  assert.equal(previewCountRow(5, 3, true).status, "blocked");
  assert.equal(previewCountRow(5, 3, true).lowers, false);
});

test("summary counts rows per status and flags lowerings", () => {
  const rows = [previewCountRow(0, 1, false), previewCountRow(5, 3, false), previewCountRow(2, 2, false)];
  assert.deepEqual(summarizeCountRows(rows), { total: 6, new: 1, changed: 1, lowered: 1, identical: 1, blocked: 0 });
});
