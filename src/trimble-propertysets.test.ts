import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTrimblePsets } from "./trimble-propertysets.ts";

const entity = (id: string, psets: Record<string, unknown> = {}) => ({ id, type: "IFCBEAM", psets });

test("a Trimble property set lands in the same psets object as IFC ones", () => {
  const entities = [entity("E1", { Pset_BeamCommon: { Reference: "B-01" } })];
  const values = [{ link: "frn:tccs:E1", psetName: "BLITTA", values: { Coating: "RAL9005" } }];

  const { entities: merged } = mergeTrimblePsets(entities, values);
  const psets = merged[0].psets as Record<string, Record<string, unknown>>;

  // The IFC-native set is untouched...
  assert.deepEqual(psets.Pset_BeamCommon, { Reference: "B-01" });
  // ...and the Trimble one sits beside it, structurally identical.
  assert.deepEqual(psets.BLITTA, { Coating: "RAL9005" });
});

test("entities without Trimble properties are returned unchanged", () => {
  const entities = [entity("E1"), entity("E2")];
  const values = [{ link: "frn:tccs:E1", psetName: "BLITTA", values: { Coating: "X" } }];

  const { entities: merged, diagnostics } = mergeTrimblePsets(entities, values);
  assert.deepEqual((merged[1].psets as Record<string, unknown>), {}, "E2 keeps an empty psets");
  assert.equal(diagnostics.matchedEntities, 1);
});

test("a Trimble set merges into an IFC set of the same name, not over it", () => {
  const entities = [entity("E1", { BLITTA: { Existing: "keep" } })];
  const values = [{ link: "frn:tccs:E1", psetName: "BLITTA", values: { Added: "new" } }];

  const { entities: merged } = mergeTrimblePsets(entities, values);
  assert.deepEqual((merged[0].psets as Record<string, unknown>).BLITTA, {
    Existing: "keep",
    Added: "new",
  });
});

test("one entity can carry several Trimble property sets", () => {
  const entities = [entity("E1")];
  const values = [
    { link: "frn:tccs:E1", psetName: "A", values: { x: 1 } },
    { link: "frn:tccs:E1", psetName: "B", values: { y: 2 } },
  ];
  const { entities: merged, diagnostics } = mergeTrimblePsets(entities, values);
  const psets = merged[0].psets as Record<string, unknown>;
  assert.deepEqual(psets.A, { x: 1 });
  assert.deepEqual(psets.B, { y: 2 });
  assert.equal(diagnostics.matchedEntities, 1, "one entity, not two");
});

test("a longer FRN still matches on the trailing entity id", () => {
  // The reading the connector's RemoveFrnPrefix would get wrong.
  const entities = [entity("ENTITY456")];
  const values = [{ link: "frn:tc:model:MODEL123:ENTITY456", psetName: "P", values: { a: 1 } }];
  const { diagnostics } = mergeTrimblePsets(entities, values);
  assert.equal(diagnostics.matchedEntities, 1);
});

test("a percent-encoded FRN matches a decoded entity id", () => {
  const entities = [entity("a:b")];
  const values = [{ link: "frn:tccs:a%3Ab", psetName: "P", values: { a: 1 } }];
  const { diagnostics } = mergeTrimblePsets(entities, values);
  assert.equal(diagnostics.matchedEntities, 1, "the connector would miss this one");
});

test("a total mismatch is reported loudly, with samples from both sides", () => {
  // This is the failure mode worth guarding: as a plain left outer join it is
  // indistinguishable from "this project has no Trimble properties".
  const entities = [entity("E1"), entity("E2")];
  const values = [{ link: "frn:tccs:COMPLETELY-OTHER", psetName: "P", values: { a: 1 } }];

  const { entities: merged, diagnostics } = mergeTrimblePsets(entities, values);

  assert.equal(diagnostics.matchedEntities, 0);
  assert.equal(diagnostics.unmatchedValues, 1);
  assert.equal(diagnostics.notes.length, 1);
  assert.match(diagnostics.notes[0], /none matched a model entity/);
  assert.deepEqual(diagnostics.sampleEntityKeys, ["E1", "E2"]);
  assert.match(diagnostics.sampleLinkKeys[0], /COMPLETELY-OTHER/);
  // The entities still come back intact — a mismatch must not lose IFC data.
  assert.equal(merged.length, 2);
});

test("no values means no notes and no changes", () => {
  const entities = [entity("E1")];
  const { entities: merged, diagnostics } = mergeTrimblePsets(entities, []);
  assert.deepEqual(merged, entities);
  assert.deepEqual(diagnostics.notes, []);
  assert.equal(diagnostics.matchedEntities, 0);
});

test("an entity with no id is skipped rather than throwing", () => {
  const entities = [{ type: "IFCBEAM" } as Record<string, unknown>];
  const values = [{ link: "frn:tccs:E1", psetName: "P", values: { a: 1 } }];
  const { entities: merged } = mergeTrimblePsets(entities, values);
  assert.deepEqual(merged[0], { type: "IFCBEAM" });
});
