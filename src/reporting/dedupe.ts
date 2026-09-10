// Deduplication helpers for reporting output.
//
// Produuzit list records use a stable identifier (usually `uuid`). We key on
// that so a cumulative file never stores the same record twice, and so a record
// that changed since the last run is replaced (latest wins) rather than
// duplicated.

export function stableKey(item: unknown): string {
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const k of ["uuid", "id", "guid", "_id"]) {
      const v = o[k];
      if (v !== undefined && v !== null && (typeof v === "string" || typeof v === "number")) {
        return String(v);
      }
    }
  }
  // No recognizable id — fall back to the whole record so exact duplicates still collapse.
  return JSON.stringify(item);
}

// Merge incoming records into existing ones, keyed by stableKey.
// Incoming records overwrite existing ones with the same key (latest wins).
export function mergeUnique(existing: unknown[], incoming: unknown[]): unknown[] {
  const map = new Map<string, unknown>();
  for (const e of existing) map.set(stableKey(e), e);
  for (const i of incoming) map.set(stableKey(i), i);
  return [...map.values()];
}
