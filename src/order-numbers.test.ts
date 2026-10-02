// Order-number assignment: idempotent, priority-aware, never overwrites.
// Run: npm run test:node
import { test } from "node:test";
import assert from "node:assert/strict";
import { planOrderNumbers, summarizeOrderRows, planClientMeta, clientMetaToWrite, type AssemblyLite } from "./lib/order-numbers.ts";

const asm = (uuid: string, extra: Partial<AssemblyLite> = {}): AssemblyLite => ({ uuid, created: `2026-09-0${uuid.slice(-1)}`, ...extra });

test("four fresh constructibles get four numbers, in natural order, by creation time", () => {
  const rows = planOrderNumbers(["EL-10", "EL-2", "EL-1", "EL-3"], [asm("a4"), asm("a1"), asm("a3"), asm("a2")]);
  assert.deepEqual(rows.map((r) => [r.order, r.assembly_uuid, r.status]), [
    ["EL-1", "a1", "assign"], ["EL-2", "a2", "assign"], ["EL-3", "a3", "assign"], ["EL-10", "a4", "assign"],
  ]);
});

test("priority, when set, decides which constructible gets the lowest number", () => {
  const rows = planOrderNumbers(["1", "2", "3"], [asm("a1"), asm("a2", { priority: 5 }), asm("a3", { priority: 1 })]);
  assert.deepEqual(rows.map((r) => [r.order, r.assembly_uuid]), [["1", "a3"], ["2", "a2"], ["3", "a1"]]);
});

test("a second run over the result is all identical: nothing to write", () => {
  const assemblies = [asm("a1"), asm("a2")];
  for (const r of planOrderNumbers(["X1", "X2"], assemblies)) {
    assemblies.find((a) => a.uuid === r.assembly_uuid)!.client_order_id = r.order;
  }
  const again = planOrderNumbers(["X2", "X1"], assemblies);
  assert.deepEqual(summarizeOrderRows(again), { assign: 0, identical: 2, other: 0, no_constructible: 0 });
});

test("client_meta: a missing or blank key is added, an existing one is never overwritten", () => {
  const rows = planClientMeta({ gevel: "Z", verdieping: "2", uid: "K-1", leeg: " " }, { gevel: "N", verdieping: 2, uid: "" });
  assert.deepEqual(rows.map((r) => [r.key, r.status, r.existing]), [["gevel", "differs", "N"], ["verdieping", "identical", "2"], ["uid", "add", null]]);
  assert.deepEqual(clientMetaToWrite(rows, { gevel: "N", verdieping: 2, uid: "" }), { gevel: "N", verdieping: 2, uid: "K-1" });
  // Nothing to add: no write at all. Not a key-value object: left alone.
  assert.equal(clientMetaToWrite(planClientMeta({ gevel: "N" }, { gevel: "N" }), { gevel: "N" }), null);
  assert.deepEqual(planClientMeta({ gevel: "Z" }, "free text").map((r) => r.status), ["differs"]);
});

test("an existing foreign number is never overwritten; surplus numbers are reported", () => {
  const rows = planOrderNumbers(["N1", "N2", "N3"], [asm("a1", { client_order_id: "OLD" }), asm("a2"), asm("a3", { client_order_id: "N3" })]);
  assert.deepEqual(summarizeOrderRows(rows), { assign: 1, identical: 1, other: 1, no_constructible: 1 });
  assert.equal(rows.find((r) => r.status === "other")!.assembly_uuid, "a1");
  assert.equal(rows.find((r) => r.status === "assign")!.assembly_uuid, "a2");
});
