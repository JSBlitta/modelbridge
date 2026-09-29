import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAllPsetPages } from "./trimble-client.ts";
import { pickLocale } from "./trimble-propertysets.ts";

// The Property Set service pages with an opaque cursor echoed back as `next`,
// not with an offset. Sending `offset` is silently ignored, so the previous
// offset-based loop re-read page 1 until it hit its 500-page ceiling — which is
// how a few hundred real psets were reported as "values=100000" (500 x top=200).
test("the pager follows `next` to the end, including an empty page that has one", () => {
  const pages: Record<string, unknown> = {
    "start": { items: [1, 2], next: "https://pset/p2" },
    // Documented behaviour: "can return an empty result set and a `next` if all
    // the items read for the page of results are filtered out".
    "https://pset/p2": { items: [], next: "https://pset/p3" },
    "https://pset/p3": { items: [3] },
  };
  const seen: string[] = [];
  const get = async (u: string) => {
    seen.push(u);
    return pages[u === "https://pset/libs/L/defs/D/psets" ? "start" : u];
  };

  return fetchAllPsetPages("https://pset/libs/L/defs/D/psets", undefined, 500, get).then((all) => {
    assert.deepEqual(all, [1, 2, 3], "a short page mid-sequence must not end the loop");
    assert.equal(seen.length, 3);
  });
});

test("the first request carries top and the caller's link filter, and no offset", async () => {
  let params: Record<string, string> | undefined;
  await fetchAllPsetPages("https://pset/psets", { link: "frn:tcfile:M1" }, 500, async (_u, p) => {
    params = p;
    return { items: [] };
  });
  assert.equal(params?.link, "frn:tcfile:M1");
  assert.equal(params?.top, "500");
  assert.equal(params?.offset, undefined, "offset is not part of this API's dialect");
});

test("a page without `next` ends the sequence even when it is full", async () => {
  let calls = 0;
  const all = await fetchAllPsetPages("https://pset/psets", undefined, 2, async () => {
    calls++;
    return { items: [calls, calls] };
  });
  assert.equal(calls, 1);
  assert.deepEqual(all, [1, 1]);
});

test("pset-set names prefer a locale, then the definition's own name, then its id", () => {
  assert.equal(pickLocale({ "en-US": { name: "US" }, en: { name: "EN" } }).name, "US");
  assert.equal(pickLocale({ en: { name: "EN" } }).name, "EN");
  // A library authored in another language: any real locale beats falling back
  // to the opaque definition id. "__prop-order__" is a control block, not one.
  assert.equal(pickLocale({ "__prop-order__": { name: "x" }, nl: { name: "NL" } }).name, "NL");
  assert.deepEqual(pickLocale(undefined), {});
});
