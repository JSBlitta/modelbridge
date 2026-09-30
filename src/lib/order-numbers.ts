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
//      the constructibles that have no number yet, ordered by their priority
//      when it is set (lowest first), then by creation time.
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

export function planOrderNumbers(orders: string[], assemblies: AssemblyLite[]): OrderPlanRow[] {
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

  remaining.forEach((o, i) => {
    const a = free[i];
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
