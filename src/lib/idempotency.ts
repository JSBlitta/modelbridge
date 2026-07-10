export interface DiffResult {
  item: Record<string, unknown>;
  status: "found" | "new";
  existing_item: Record<string, unknown> | null;
}

export function compareBatches(
  existing: Record<string, unknown>[],
  proposed: Record<string, unknown>[],
  key = "name",
): DiffResult[] {
  const existingMap = new Map<string, Record<string, unknown>>();
  for (const item of existing) {
    const k = item[key] as string;
    if (k) existingMap.set(k, item);
  }
  return proposed.map((item) => {
    const k = item[key] as string;
    if (k && existingMap.has(k)) {
      return { item, status: "found", existing_item: existingMap.get(k)! };
    }
    return { item, status: "new", existing_item: null };
  });
}

const DIFF_FIELDS = ["scheduled_prod_date", "client_order_id", "priority", "client_meta"] as const;

export interface AssemblyDiffResult {
  item: Record<string, unknown>;
  status: "new" | "changed" | "identical";
  existing_item: Record<string, unknown> | null;
  changed_fields: string[];
}

export function compareAssemblies(
  existing: Record<string, unknown>[],
  proposed: Record<string, unknown>[],
  key = "design",
): AssemblyDiffResult[] {
  const existingMap = new Map<string, Record<string, unknown>>();
  for (const item of existing) {
    const k = item[key] as string;
    if (k) existingMap.set(k, item);
  }

  return proposed.map((item) => {
    const k = item[key] as string;
    if (!k || !existingMap.has(k)) {
      return { item, status: "new" as const, existing_item: null, changed_fields: [] };
    }
    const ex = existingMap.get(k)!;
    const changed: string[] = [];
    for (const field of DIFF_FIELDS) {
      if (field in item && JSON.stringify(item[field]) !== JSON.stringify(ex[field])) {
        changed.push(field);
      }
    }
    return {
      item,
      status: changed.length ? ("changed" as const) : ("identical" as const),
      existing_item: ex,
      changed_fields: changed,
    };
  });
}
