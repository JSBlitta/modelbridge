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

// Parse a production count value — invalid or missing values default to 1
// so existing single-assembly behaviour is preserved.
export function parseCount(val: unknown): number {
  if (val == null || val === "") return 1;
  if (typeof val === "number") return val >= 1 ? Math.floor(val) : 1;
  const n = parseInt(String(val).trim(), 10);
  return isNaN(n) || n < 1 ? 1 : n;
}

// Generate unique order IDs for count-based creation, e.g. "A20-EL-001"
export function generateOrderIds(prefix: string, start: number, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(`${prefix}-${String(start + i).padStart(3, "0")}`);
  }
  return ids;
}

export function orderPrefix(designName: string): string {
  return (designName || "element").replace(/\s+/g, "-");
}
