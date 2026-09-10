// Trimble FRN (Federated Resource Name) parsing.
//
// An FRN is a URN-shaped reference, ARN-style: `frn:<namespace>:<resource>`,
// where the resource tail may itself contain colons and may be percent-encoded.
//
// The Power BI connector this was ported from handles these with
// `RemoveFrnPrefix` (Helpers.pqm:220): split on ":", drop the first two
// segments, rejoin the rest with ":". It never percent-decodes. `DecodeUrl`
// exists in the same file but is applied only to tree and node *names*
// (Organizer.pqm:49,67) — never to a link. So any link carrying an encoded
// character keeps it, and a join against a raw entity id silently misses.
//
// We also cannot be certain the tail is a single segment for every resource
// type. The connector's own rejoin-with-colons implies its author expected a
// multi-segment tail, yet Organizer.pqm:19 feeds the stripped value straight
// into `/libs/{libId}/defs` — a URL that evidently works, which only holds if
// that tail is a bare id. Library and entity FRNs may simply differ in arity.
//
// Rather than pick one reading and hope, parseFrn exposes every plausible key
// and the join tries them in order. A mismatch then shows up as a reported
// diagnostic instead of a column of nulls.

export interface ParsedFrn {
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
      candidates: dedupe([decoded, raw]),
    };
  }

  const segments = raw.split(":");
  const namespace = segments[1] ?? "";
  const tailSegments = segments.slice(2);

  const path = safeDecode(tailSegments.join(":"));
  const id = safeDecode(tailSegments[tailSegments.length - 1] ?? "");

  return {
    raw,
    isFrn: true,
    namespace,
    path,
    id,
    // Order matters: the bare trailing id is the likeliest join key, then the
    // full tail (the connector's interpretation), then the undecoded forms in
    // case the other side of the join is itself still encoded.
    candidates: dedupe([id, path, tailSegments.join(":"), raw]),
  };
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
