// Trimble FRN (Fulcrum Resource Notation) parsing.
//
// The grammar is no longer guesswork. Trimble's own Postman collection
// "Documentation for Workflow Extentions Integrators" (public workspace
// trimble-connect-s-public-workspace, request *Property sets → Instantiating
// property sets → Pointing to 3D elements*) states it outright, for an element
// whose id is `0PntyzmZHFWh4O3ogKil7e`:
//
//   frn:entity:0PntyzmZHFWh4O3ogKil7e
//   frn:tcfile:q-XKNAhg3Rk/entity:0PntyzmZHFWh4O3ogKil7e
//   frn:tcfile:q-XKNAhg3Rk:woC32em2Fb0/entity:0PntyzmZHFWh4O3ogKil7e
//
// and for an Organizer node:
//
//   frn:forest:BAA01Z424_8/tree:087b105342c244608bbc65c2f0f4c765
//   frn:forest:BAA01Z424_8/tree:087b1053…/node:9e91a83ba1854f76aa0cede175ab8346
//
// So after `frn:` the reference is a **`/`-separated** list of `type:value`
// parts — the separator the Power BI connector's `RemoveFrnPrefix`
// (Helpers.pqm:220) never knew about, because it only ever split on ":".
//
// That gives an exact join key: the value of the `entity` part. `candidates`
// keeps the older heuristic readings behind it, so a link shaped in some way
// Trimble has not documented still has a chance of joining rather than
// silently producing a column of nulls.

/** The parts of an entity FRN we can address a model with. */
export interface FrnParts {
  /** Value of the `entity:` part, percent-decoded. "" when there is none. */
  entityId: string;
  /** Value of the `tcfile:` part — the model/file id. "" when there is none. */
  fileId: string;
}

export interface ParsedFrn extends FrnParts {
  /** The input, unchanged. */
  raw: string;
  /** True when the input actually looked like an FRN. */
  isFrn: boolean;
  /** Namespace segment (`tc`, `tccs`, …), or "" for a non-FRN input. */
  namespace: string;
  /** Everything after `frn:<namespace>:`, percent-decoded. May contain colons. */
  path: string;
  /** The last colon-separated segment of `path`, percent-decoded. */
  id: string;
  /**
   * Every value this FRN could plausibly be meant to match, most-likely first
   * and de-duplicated. Used as join candidates.
   */
  candidates: string[];
}

/** Percent-decode, tolerating a malformed sequence rather than throwing. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseFrn(input: string | null | undefined): ParsedFrn {
  const raw = typeof input === "string" ? input.trim() : "";

  if (!raw.toLowerCase().startsWith("frn:")) {
    const decoded = safeDecode(raw);
    return {
      raw,
      isFrn: false,
      namespace: "",
      path: decoded,
      id: decoded,
      entityId: "",
      fileId: "",
      candidates: dedupe([decoded, raw]),
    };
  }

  const segments = raw.split(":");
  const namespace = segments[1] ?? "";
  const tailSegments = segments.slice(2);

  const path = safeDecode(tailSegments.join(":"));
  const id = safeDecode(tailSegments[tailSegments.length - 1] ?? "");
  const { entityId, fileId } = splitFrnParts(raw);

  return {
    raw,
    isFrn: true,
    namespace,
    path,
    id,
    entityId,
    fileId,
    // Order matters: the documented entity id first, then the bare trailing
    // segment, the full tail (the connector's reading), and finally the
    // undecoded forms in case the other side of the join is still encoded.
    candidates: dedupe([entityId, id, path, tailSegments.join(":"), raw]),
  };
}

/**
 * Split `frn:<type>:<value>[/<type>:<value>…]` into the parts we join on.
 *
 * `frn:entity:X` has no `/`, so the whole remainder is one part; the
 * `frn:tcfile:<file>[:<version>]/entity:<id>` forms have two, and only the
 * `entity` part carries the model entity id.
 */
function splitFrnParts(raw: string): FrnParts {
  let entityId = "";
  let fileId = "";

  for (const part of raw.slice("frn:".length).split("/")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const type = part.slice(0, colon).toLowerCase();
    const value = part.slice(colon + 1);
    // `tcfile` alone may be `<fileId>:<versionId>`; the file id is the first.
    if (type === "entity") entityId = safeDecode(value);
    else if (type === "tcfile") fileId = safeDecode(value.split(":")[0] ?? "");
  }

  return { entityId, fileId };
}

/**
 * The `link` prefixes that select every pset attached to one model.
 *
 * `/libs/{libId}/defs/{defId}/psets?link=` is a plain string **prefix** filter
 * (Trimble's own example filters `frn:lib:<accountLibId>` to find the project
 * libraries derived from it). `frn:tcfile:<modelId>` therefore covers both the
 * versioned and unversioned file forms in one query. The bare `frn:entity:`
 * form carries no file id at all, so it needs a second query — dropping it
 * would silently lose every pset attached without a file prefix.
 */
export function psetLinkPrefixesForModel(modelId: string): string[] {
  return [`frn:tcfile:${modelId}`, "frn:entity:"];
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) if (v && !out.includes(v)) out.push(v);
  return out;
}

/**
 * Index a set of FRN-keyed records by every candidate key, so a lookup can be
 * attempted against whichever form the other side of the join actually uses.
 */
export function indexByFrnCandidates<T>(
  items: T[],
  frnOf: (item: T) => string | null | undefined,
): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    const parsed = parseFrn(frnOf(item));
    for (const key of parsed.candidates) {
      // First writer wins: candidates are ordered by likelihood, and a later
      // item's fallback key must not displace an earlier item's primary key.
      if (!index.has(key)) index.set(key, item);
    }
  }
  return index;
}
