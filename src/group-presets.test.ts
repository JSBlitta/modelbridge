import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandTokens,
  groupSubject,
  matchFolders,
  mergeAssignments,
  normalizeAcl,
  normalizeLevel,
  sameAcl,
  type FolderRef,
} from "./lib/group-preset-rules.ts";

const folders: FolderRef[] = [
  { id: "f-wip", name: "01-WIP", path: "01-WIP" },
  { id: "f-arc", name: "02-ARC", path: "01-WIP/02-ARC" },
  { id: "f-str", name: "03-STR", path: "01-WIP/03-STR" },
  { id: "f-acme-in", name: "Incoming", path: "20-SHARED/ACME/Incoming" },
  { id: "f-acme-out", name: "Outgoing", path: "20-SHARED/ACME/Outgoing" },
];

test("expandTokens replaces $TOKEN and ${TOKEN}", () => {
  assert.equal(expandTokens("$COMPANY_NAME/Incoming", { COMPANY_NAME: "ACME" }), "ACME/Incoming");
  assert.equal(expandTokens("${GROUP_NAME}/x", { GROUP_NAME: "Steel" }), "Steel/x");
  // Unknown tokens are left untouched rather than silently blanked.
  assert.equal(expandTokens("$UNKNOWN/x", { COMPANY_NAME: "ACME" }), "$UNKNOWN/x");
});

test("normalizeLevel accepts aliases and rejects junk", () => {
  assert.equal(normalizeLevel("view"), "READ");
  assert.equal(normalizeLevel("Full Access"), "FULL_ACCESS");
  assert.equal(normalizeLevel("no_access"), "NO_ACCESS");
  assert.throws(() => normalizeLevel("OWNER"), /Unknown permission level/);
});

test("PATH: literal path matches exactly (case-insensitive)", () => {
  const m = matchFolders({ match_type: "PATH", pattern: "01-WIP/02-ARC" }, folders, {});
  assert.deepEqual(m.matched.map((f) => f.id), ["f-arc"]);
  assert.equal(m.missing, undefined);
});

test("PATH: a missing literal path is reported", () => {
  const m = matchFolders({ match_type: "PATH", pattern: "99-NOPE" }, folders, {});
  assert.equal(m.matched.length, 0);
  assert.equal(m.missing, "99-NOPE");
});

test("PATH: single * matches one segment, ** matches across segments", () => {
  const one = matchFolders({ match_type: "PATH", pattern: "01-WIP/*" }, folders, {});
  assert.deepEqual(one.matched.map((f) => f.id).sort(), ["f-arc", "f-str"]);
  const deep = matchFolders({ match_type: "PATH", pattern: "01-WIP/**" }, folders, {});
  assert.deepEqual(deep.matched.map((f) => f.id).sort(), ["f-arc", "f-str"]);
});

test("PATH: $COMPANY_NAME expands to the group name", () => {
  const m = matchFolders(
    { match_type: "PATH", pattern: "20-SHARED/$COMPANY_NAME/**" },
    folders,
    { COMPANY_NAME: "ACME" },
  );
  assert.deepEqual(m.matched.map((f) => f.id).sort(), ["f-acme-in", "f-acme-out"]);
});

test("REGEX: matches against the full path; invalid patterns are reported", () => {
  const m = matchFolders({ match_type: "REGEX", pattern: "ACME/(Incoming|Outgoing)$" }, folders, {});
  assert.deepEqual(m.matched.map((f) => f.id).sort(), ["f-acme-in", "f-acme-out"]);
  const bad = matchFolders({ match_type: "REGEX", pattern: "(" }, folders, {});
  assert.equal(bad.matched.length, 0);
  assert.ok(bad.invalid);
});

test("normalizeAcl cleans levels, drops empties and de-duplicates", () => {
  const acl = normalizeAcl({ view: ["u1", "u1"], FULL: ["u2", ""], bogus: ["u3"] });
  assert.deepEqual(acl, { READ: ["u1"], FULL_ACCESS: ["u2"] });
});

test("mergeAssignments moves a subject between levels and keeps others", () => {
  const current = { READ: ["old", "u1"], FULL_ACCESS: ["u2"] };
  const merged = mergeAssignments(current, [{ subjectId: "u1", level: "FULL_ACCESS" }]);
  assert.deepEqual(merged, { READ: ["old"], FULL_ACCESS: ["u2", "u1"] });
});

test("sameAcl ignores order and empty levels, not levels or subjects", () => {
  const acl = { READ: ["a", "b"], FULL_ACCESS: [groupSubject("g1")] };
  assert.equal(groupSubject("g1"), "tc-groups:g1");
  assert.ok(sameAcl(acl, { FULL_ACCESS: ["tc-groups:g1"], READ: ["b", "a"], NO_ACCESS: [] }));
  assert.ok(!sameAcl(acl, { READ: ["a"], FULL_ACCESS: ["tc-groups:g1"] }));
  assert.ok(!sameAcl(acl, { READ: ["a", "b", "tc-groups:g1"] }));
});
