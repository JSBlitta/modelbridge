// Assigning order numbers to individual constructibles.
//
// A production count makes Produuzit create N constructibles (assemblies) of a
// design in a batch; they are interchangeable until each gets the order number
// that says where it goes in the building. This plans that assignment for one
// (batch, design) group:
//
//   1. A constructible that already carries one of the selected order numbers
//      keeps it ("identical"). Produuzit's own client_order_id is the
//      registration, so a second run finds everything identical and writes
//      nothing.
//   2. The remaining order numbers, in natural order (EL-2 before EL-10), go to
//      the constructibles that have no number yet. A constructible that already
//      agrees with the element behind a number (it carries that element's
//      client_meta) gets that number; the rest are handed out by priority when
//      it is set (lowest first), then by creation time.
//   3. A constructible with a number that is not in the selection is never
//      overwritten; it is reported as "other" so a person decides.
//   4. Order numbers left over when the free constructibles run out are
//      reported as "no_constructible" (the production count is too low, or the
//      constructibles do not exist yet).

export interface AssemblyLite {
  uuid: string;
  client_order_id?: string | null;
  priority?: number | null;
  created?: string | null;
}

export type OrderRowStatus = "identical" | "assign" | "other" | "no_constructible";

export interface OrderPlanRow {
  status: OrderRowStatus;
  order: string | null;          // order number from the selection (null for "other")
  assembly_uuid: string | null;  // null for "no_constructible"
  existing: string | null;       // the constructible's current number
  priority: number | null;
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const hasNumber = (a: AssemblyLite) => String(a.client_order_id ?? "").trim() !== "";
const priorityOf = (a: AssemblyLite) =>
  typeof a.priority === "number" && Number.isFinite(a.priority) ? a.priority : null;

// `affinity` scores how strongly a free constructible already belongs to the
// element behind an order number (0: not at all). Without it the pairing is by
// position only.
export function planOrderNumbers(
  orders: string[],
  assemblies: AssemblyLite[],
  affinity?: (order: string, assembly: AssemblyLite) => number,
): OrderPlanRow[] {
  const wanted = [...new Set(orders.map((o) => o.trim()).filter(Boolean))];
  const byNumber = new Map<string, AssemblyLite>();
  for (const a of assemblies) if (hasNumber(a)) byNumber.set(String(a.client_order_id).trim(), a);

  const rows: OrderPlanRow[] = [];
  const remaining: string[] = [];
  for (const o of wanted) {
    const a = byNumber.get(o);
    if (a) rows.push({ status: "identical", order: o, assembly_uuid: a.uuid, existing: o, priority: priorityOf(a) });
    else remaining.push(o);
  }
  remaining.sort(natural.compare);

  const free = assemblies.filter((a) => !hasNumber(a)).sort((x, y) => {
    const px = priorityOf(x), py = priorityOf(y);
    if (px !== py) return px === null ? 1 : py === null ? -1 : px - py;
    return String(x.created ?? "").localeCompare(String(y.created ?? "")) || x.uuid.localeCompare(y.uuid);
  });

  // Strongest pairs first, ties by order number then priority. Greedy, not a
  // maximum matching: enough while one key (the order ID copy) identifies the element.
  const claimed = new Map<string, AssemblyLite>();
  const taken = new Set<string>();
  if (affinity) {
    const pairs = remaining
      .flatMap((o, oi) => free.map((f, fi) => ({ o, f, oi, fi, score: affinity(o, f) })))
      .filter((p) => p.score > 0)
      .sort((x, y) => y.score - x.score || x.oi - y.oi || x.fi - y.fi);
    for (const { o, f } of pairs) {
      if (claimed.has(o) || taken.has(f.uuid)) continue;
      claimed.set(o, f);
      taken.add(f.uuid);
    }
  }
  const unclaimed = free.filter((f) => !taken.has(f.uuid));
  let next = 0;

  remaining.forEach((o) => {
    const a = claimed.get(o) ?? unclaimed[next++];
    rows.push(a
      ? { status: "assign", order: o, assembly_uuid: a.uuid, existing: null, priority: priorityOf(a) }
      : { status: "no_constructible", order: o, assembly_uuid: null, existing: null, priority: null });
  });

  const selected = new Set(wanted);
  for (const a of assemblies) {
    if (hasNumber(a) && !selected.has(String(a.client_order_id).trim())) {
      rows.push({ status: "other", order: null, assembly_uuid: a.uuid, existing: String(a.client_order_id).trim(), priority: priorityOf(a) });
    }
  }
  return rows;
}

export function summarizeOrderRows(rows: { status: OrderRowStatus }[]) {
  const n = (s: OrderRowStatus) => rows.filter((r) => r.status === s).length;
  return { assign: n("assign"), identical: n("identical"), other: n("other"), no_constructible: n("no_constructible") };
}

// client_meta on a constructible, compared per key against what the selection
// says. Same rule as the order numbers: a key Produuzit does not have yet is
// added ("add"), a key it has is never overwritten ("differs" is reported so a
// person decides).

export type MetaStatus = "add" | "identical" | "differs";

export interface MetaRow {
  key: string;
  proposed: string;
  existing: string | null;  // Produuzit's current value, null when the key is missing
  status: MetaStatus;
}

const isBlank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
const show = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v).trim());

export function planClientMeta(desired: Record<string, string>, existing: unknown): MetaRow[] {
  const wanted = Object.entries(desired).map(([k, v]) => [k, String(v ?? "").trim()] as const).filter(([, v]) => v !== "");
  // Something that is not a key-value object (a bare string, an array) cannot be
  // merged into without replacing it, so every key counts as differing.
  if (!isBlank(existing) && (typeof existing !== "object" || Array.isArray(existing))) {
    return wanted.map(([key, proposed]) => ({ key, proposed, existing: show(existing), status: "differs" }));
  }
  const have = (existing ?? {}) as Record<string, unknown>;
  return wanted.map(([key, proposed]) => {
    const cur = have[key];
    if (isBlank(cur)) return { key, proposed, existing: null, status: "add" };
    return { key, proposed, existing: show(cur), status: show(cur) === proposed ? "identical" : "differs" };
  });
}

// The client_meta to PATCH: Produuzit's own object with the "add" keys laid on
// top, so keys from other sources survive whether Produuzit merges or replaces.
// Null when there is nothing to add.
export function clientMetaToWrite(rows: MetaRow[], existing: unknown): Record<string, unknown> | null {
  const adds = rows.filter((r) => r.status === "add");
  if (!adds.length) return null;
  return { ...((existing ?? {}) as Record<string, unknown>), ...Object.fromEntries(adds.map((r) => [r.key, r.proposed])) };
}
