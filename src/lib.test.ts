// Smallest set of checks that fail if the logic most likely to silently corrupt
// an import breaks. Run with `npm test`.
//
// Deliberately no framework and no fixtures: node:test is built in.

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitCsvDocument, splitCsvLine, detectDelimiter } from "./csv-parser.ts";
import { parseCount, findSource } from "./lib/mapping.ts";
import { fingerprint } from "./lib/fingerprint.ts";
import { isUuid, isOpaqueId, boundedInt } from "./lib/validate.ts";
import { compareAssemblies } from "./lib/idempotency.ts";

// --- CSV ---------------------------------------------------------------

test("splitCsvDocument keeps a quoted newline inside one field", () => {
  const rows = splitCsvDocument('a,"line one\nline two",c', ",");
  assert.equal(rows.length, 1, "a quoted newline must not start a new record");
  assert.deepEqual(rows[0], ["a", "line one\nline two", "c"]);
});

test("splitCsvDocument handles quoted delimiters and escaped quotes", () => {
  const rows = splitCsvDocument('"a,b","he said ""hi""",c', ",");
  assert.deepEqual(rows[0], ["a,b", 'he said "hi"', "c"]);
});

test("splitCsvDocument preserves whitespace inside quotes but trims outside", () => {
  const rows = splitCsvDocument('"  padded  " ,  bare  ', ",");
  assert.equal(rows[0][0], "  padded  ");
  assert.equal(rows[0][1], "bare");
});

test("splitCsvDocument splits normal records and skips blank lines", () => {
  const rows = splitCsvDocument("a,b\r\nc,d\r\n\r\ne,f", ",");
  assert.deepEqual(rows, [["a", "b"], ["c", "d"], ["e", "f"]]);
});

test("splitCsvLine still works on a single line", () => {
  assert.deepEqual(splitCsvLine("x;y;z", ";"), ["x", "y", "z"]);
});

test("detectDelimiter ignores separators inside quotes", () => {
  assert.equal(detectDelimiter('"a;b;c;d",e'), ",");
  assert.equal(detectDelimiter("a;b;c"), ";");
});

// --- mapping -----------------------------------------------------------

test("parseCount defaults to 1 for missing or invalid values", () => {
  for (const bad of [null, undefined, "", "abc", 0, -3, "0"]) {
    assert.equal(parseCount(bad), 1, `parseCount(${JSON.stringify(bad)})`);
  }
  assert.equal(parseCount("7"), 7);
  assert.equal(parseCount(4.9), 4);
});

test("findSource resolves both single and duplicated mapping targets", () => {
  const mapping = { ColA: "design_name", ColB: ["batch_number", "client_order_id"] };
  assert.equal(findSource(mapping, "design_name"), "ColA");
  assert.equal(findSource(mapping, "client_order_id"), "ColB");
  assert.equal(findSource(mapping, "nope"), "");
});

// --- push gate fingerprint --------------------------------------------

test("fingerprint ignores object key order", () => {
  assert.equal(
    fingerprint({ a: 1, b: { c: 2, d: 3 } }),
    fingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  );
});

test("fingerprint is sensitive to array order and to any value change", () => {
  assert.notEqual(fingerprint({ rows: [1, 2] }), fingerprint({ rows: [2, 1] }));
  assert.notEqual(fingerprint({ count: 1 }), fingerprint({ count: 2 }));
});

test("fingerprint changes when a column mapping changes", () => {
  const base = { project_uuid: "p", column_mapping: { A: "design_name" }, rows: [] };
  const edited = { project_uuid: "p", column_mapping: { A: "batch_number" }, rows: [] };
  assert.notEqual(fingerprint(base), fingerprint(edited));
});

// --- validation --------------------------------------------------------

test("isUuid accepts a real uuid and rejects traversal attempts", () => {
  assert.ok(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
  assert.equal(isUuid("../../company/api_accounts"), false);
  assert.equal(isUuid("..%2f..%2fcompany"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(undefined), false);
});

test("isOpaqueId rejects anything that could change a URL path", () => {
  assert.ok(isOpaqueId("abc-123_XY"));
  assert.equal(isOpaqueId("foo/../bar"), false);
  assert.equal(isOpaqueId("a?b=c"), false);
  assert.equal(isOpaqueId("https://evil.example"), false);
});

test("boundedInt clamps and falls back instead of yielding NaN", () => {
  assert.equal(boundedInt("50", 10, 1, 100), 50);
  assert.equal(boundedInt("abc", 10, 1, 100), 10);
  assert.equal(boundedInt(undefined, 10, 1, 100), 10);
  assert.equal(boundedInt("99999", 10, 1, 100), 100);
  assert.equal(boundedInt("-5", 10, 1, 100), 1);
});

// --- idempotency -------------------------------------------------------

test("compareAssemblies flags only the fields that actually changed", () => {
  const existing = [{ design: "d1", priority: 1, client_order_id: "x" }];
  const proposed = [{ design: "d1", priority: 2, client_order_id: "x" }];
  const [row] = compareAssemblies(existing, proposed, "design");
  assert.equal(row.status, "changed");
  assert.deepEqual(row.changed_fields, ["priority"]);
});

test("compareAssemblies reports an unseen design as new", () => {
  const [row] = compareAssemblies([], [{ design: "d9" }], "design");
  assert.equal(row.status, "new");
  assert.equal(row.existing_item, null);
});
