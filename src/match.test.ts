import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestCanonicals } from "./lib/column-match.ts";
import { buildProjectMatcher, projectPrefix } from "./lib/produuzit-topology.ts";
import { parseAssemblyCsv } from "./csv-parser.ts";

const SYN = {
  design: ["design", "element_code", "element"],
  batch: ["batch", "batch_nr", "levering-productie"],
  count: ["count", "aantal"],
  phase: ["fase"],
};

test("CSV headers map like the Trimble flow: case, spaces, dashes, substrings", () => {
  const csv = "Element Code;Batch-Nr;Aantal stuks;Opmerking\nEL-1;1;3;x\n";
  assert.deepEqual(parseAssemblyCsv(csv, SYN, {}).col_map, {
    design: "Element Code",
    batch: "Batch-Nr",
    count: "Aantal stuks", // substring fallback
  });
});

test("an exact match beats a substring match on another column", () => {
  assert.deepEqual(suggestCanonicals(["Batch omschrijving", "Batch"], SYN), { Batch: "batch" });
});

test("Trimble property paths match on their leaf", () => {
  assert.deepEqual(suggestCanonicals(["Pset.Element_Code", "Pset.Fase"], SYN, (p) => p.split(".").pop()!), {
    "Pset.Element_Code": "design",
    "Pset.Fase": "phase",
  });
});

const P = (name: string, uuid = name) => ({ name, uuid, project_number: name });

test("projectPrefix is the first 7 characters of <5 digits>-<letter>", () => {
  assert.equal(projectPrefix("12654-A-NorthEast Wing"), "12654-A");
  assert.equal(projectPrefix("12654-a"), "12654-A");
  assert.equal(projectPrefix("12654-AB-x"), null);
  assert.equal(projectPrefix("1000-A-gevel"), null);
});

test("12654-A resolves to 12654-A-NorthEast Wing", () => {
  const match = buildProjectMatcher([P("12654-A-NorthEast Wing"), P("12654-B-South")]);
  assert.deepEqual(match("12654-A"), { project: P("12654-A-NorthEast Wing") });
  assert.deepEqual(match("12654-A-gevel"), { project: P("12654-A-NorthEast Wing") });
  assert.equal(match("12654-C"), null);
});

test("an exact name wins over the prefix", () => {
  const match = buildProjectMatcher([P("12654-A-North"), P("12654-A-South")]);
  assert.deepEqual(match("12654-A-South"), { project: P("12654-A-South") });
});

test("two projects sharing a prefix never resolve to one", () => {
  const match = buildProjectMatcher([P("12655-B-North"), P("12655-B-South")]);
  assert.deepEqual(match("12655-B"), { ambiguous: ["12655-B-North", "12655-B-South"] });
});

test("names outside the pattern still need an exact match", () => {
  const match = buildProjectMatcher([P("1000-A-gevel")]);
  assert.deepEqual(match("1000-A-gevel"), { project: P("1000-A-gevel") });
  assert.equal(match("1000-A"), null);
});
