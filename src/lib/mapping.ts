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
