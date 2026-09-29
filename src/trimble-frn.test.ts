import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrn, safeDecode, indexByFrnCandidates, psetLinkPrefixesForModel } from "./trimble-frn.ts";

// The two readings of the FRN grammar that the connector source leaves open.
// parseFrn must serve both, because we cannot tell from the M code which is
// right and guessing wrong yields a silent all-null join.

test("two-segment prefix: frn:<ns>:<id> yields the bare id", () => {
  const p = parseFrn("frn:tccs:2vX9pQ_abc");
  assert.equal(p.isFrn, true);
  assert.equal(p.namespace, "tccs");
  assert.equal(p.id, "2vX9pQ_abc");
  assert.equal(p.path, "2vX9pQ_abc");
});

test("longer tail: the bare id and the full tail are both offered", () => {
  const p = parseFrn("frn:tc:model:MODEL123:ENTITY456");
  assert.equal(p.id, "ENTITY456", "trailing segment is the likeliest join key");
  assert.equal(p.path, "model:MODEL123:ENTITY456", "the connector's reading");
  // Both must be reachable, since only a live call settles which is correct.
  assert.ok(p.candidates.includes("ENTITY456"));
  assert.ok(p.candidates.includes("model:MODEL123:ENTITY456"));
  assert.equal(p.candidates[0], "ENTITY456", "most likely first");
});

test("percent-encoded ids are decoded — the gap in the connector", () => {
  // The connector strips the prefix but never calls DecodeUrl on a link, so an
  // encoded id stays encoded and never matches a raw entity id.
  const p = parseFrn("frn:tccs:some%3Aid%2Fwith%20chars");
  assert.equal(p.id, "some:id/with chars");
  assert.ok(p.candidates.includes("some%3Aid%2Fwith%20chars"), "encoded form kept as a fallback");
});

test("an encoded colon does not split the tail", () => {
  // This is why encoding exists: %3A must not be treated as a separator.
  const p = parseFrn("frn:tccs:a%3Ab");
  assert.equal(p.id, "a:b");
  assert.equal(p.path, "a:b");
});

test("a malformed escape is passed through rather than throwing", () => {
  assert.equal(safeDecode("100%"), "100%");
  const p = parseFrn("frn:tccs:100%");
  assert.equal(p.id, "100%");
});

test("a plain id that is not an FRN passes through untouched", () => {
  const p = parseFrn("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(p.isFrn, false);
  assert.equal(p.id, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
});

test("null and empty input do not throw", () => {
  for (const bad of [null, undefined, ""]) {
    const p = parseFrn(bad);
    assert.equal(p.id, "");
    assert.deepEqual(p.candidates, []);
  }
});

test("case-insensitive scheme", () => {
  assert.equal(parseFrn("FRN:tccs:abc").isFrn, true);
});

test("indexByFrnCandidates finds an item by either reading of the tail", () => {
  const psets = [{ link: "frn:tc:model:M1:E1", value: "a" }];
  const index = indexByFrnCandidates(psets, (p) => p.link);
  assert.equal(index.get("E1")?.value, "a", "bare entity id");
  assert.equal(index.get("model:M1:E1")?.value, "a", "connector's stripped form");
  assert.equal(index.get("nope"), undefined);
});

test("indexByFrnCandidates does not let a fallback key shadow a primary one", () => {
  // Two psets whose candidate sets overlap: the one for which a key is the
  // primary (id) candidate must win over one for which it is a fallback.
  const psets = [
    { link: "frn:tccs:E1", tag: "primary" },
    { link: "frn:tc:other:E1", tag: "fallback-owner" },
  ];
  const index = indexByFrnCandidates(psets, (p) => p.link);
  assert.equal(index.get("E1")?.tag, "primary");
});

// The three entity-link forms Trimble documents verbatim in its public Postman
// collection ("Pointing to 3D elements"), for element id 0PntyzmZHFWh4O3ogKil7e.
const ENTITY = "0PntyzmZHFWh4O3ogKil7e";

test("the documented entity FRN forms all yield the same entity id", () => {
  for (const link of [
    `frn:entity:${ENTITY}`,
    `frn:tcfile:q-XKNAhg3Rk/entity:${ENTITY}`,
    `frn:tcfile:q-XKNAhg3Rk:woC32em2Fb0/entity:${ENTITY}`,
  ]) {
    const parsed = parseFrn(link);
    assert.equal(parsed.entityId, ENTITY, link);
    assert.equal(parsed.candidates[0], ENTITY, `${link} joins on the entity id first`);
  }
});

test("the file id is read from the tcfile part, version stripped", () => {
  assert.equal(parseFrn(`frn:tcfile:q-XKNAhg3Rk/entity:${ENTITY}`).fileId, "q-XKNAhg3Rk");
  assert.equal(parseFrn(`frn:tcfile:q-XKNAhg3Rk:woC32em2Fb0/entity:${ENTITY}`).fileId, "q-XKNAhg3Rk");
  assert.equal(parseFrn(`frn:entity:${ENTITY}`).fileId, "");
});

test("an organizer node link yields no entity id, so it cannot join a model row", () => {
  const node = "frn:forest:BAA01Z424_8/tree:087b105342c244608bbc65c2f0f4c765/node:9e91a83b";
  assert.equal(parseFrn(node).entityId, "");
});

test("model scoping asks for both the file-prefixed and the bare entity form", () => {
  // Dropping either prefix silently loses psets: the bare form carries no file
  // id at all, and the versioned form is only reachable via the file prefix.
  assert.deepEqual(psetLinkPrefixesForModel("q-XKNAhg3Rk"), [
    "frn:tcfile:q-XKNAhg3Rk",
    "frn:entity:",
  ]);
  const prefix = psetLinkPrefixesForModel("q-XKNAhg3Rk")[0];
  assert.ok(`frn:tcfile:q-XKNAhg3Rk/entity:${ENTITY}`.startsWith(prefix));
  assert.ok(`frn:tcfile:q-XKNAhg3Rk:woC32em2Fb0/entity:${ENTITY}`.startsWith(prefix));
});
