// Shared helpers for column mappings.
// A mapping entry may be a single target string or an array of targets
// (used when the same source property is duplicated to multiple Produuzit fields).

export type ColumnMapping = Record<string, string | string[]>;

export function findSource(mapping: ColumnMapping, target: string): string {
  for (const [source, t] of Object.entries(mapping)) {
    if (t === target) return source;
    if (Array.isArray(t) && t.includes(target)) return source;
  }
  return "";
}

export function targetsOf(t: string | string[]): string[] {
  return Array.isArray(t) ? t : [t];
}

// Coerce a production count value to a positive integer, falling back when it is
// missing, non-numeric or below 1.
export function normalizeCount(val: unknown, fallback = 1): number {
  const n = typeof val === "number" ? val : parseInt(String(val ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

// Parse a production count value. Invalid or missing values use `fallback`
// (the operator's default count) so behaviour is explicit at the call site.
export function parseCount(val: unknown, fallback = 1): number {
  if (val == null || val === "") return fallback;
  return normalizeCount(val, fallback);
}
