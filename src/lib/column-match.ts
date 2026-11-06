// The one column-name matcher. CSV imports (server side, csv-parser.ts) and the
// Trimble import (frontend, TrimbleImport.vue imports this file) both map their
// column or property names to config.yaml canonicals through it, so a header
// that auto-maps in one flow auto-maps in the other.

// "Batch Nr", "batch_nr" and "Batch-Nr" are the same key.
export function normalizeKey(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

// names: the columns (or property paths) to map; keyOf picks the part that is
// matched (Trimble matches a property path by its leaf). Returns name -> canonical.
// Exact normalized matches go first, then a substring fallback (longest synonym
// first, at least 3 characters) for whatever is left. Each canonical is used once.
export function suggestCanonicals(
  names: string[],
  synonyms: Record<string, string[]>,
  keyOf: (name: string) => string = (n) => n,
): Record<string, string> {
  const lookup = new Map<string, string>();
  for (const [canonical, syns] of Object.entries(synonyms ?? {})) {
    for (const syn of Array.isArray(syns) ? syns : []) {
      const key = normalizeKey(syn);
      if (key && !lookup.has(key)) lookup.set(key, canonical);
    }
  }
  const bySubstring = [...lookup.entries()].filter(([k]) => k.length >= 3).sort((a, b) => b[0].length - a[0].length);

  const out: Record<string, string> = {};
  const used = new Set<string>();
  const take = (name: string, canonical: string | undefined) => {
    if (!canonical || used.has(canonical) || name in out) return;
    out[name] = canonical;
    used.add(canonical);
  };
  for (const name of names) take(name, lookup.get(normalizeKey(keyOf(name))));
  for (const name of names) {
    const key = normalizeKey(keyOf(name));
    if (key) take(name, bySubstring.find(([syn]) => key.includes(syn))?.[1]);
  }
  return out;
}
