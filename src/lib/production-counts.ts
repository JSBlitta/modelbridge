import { apiGet, apiPut } from "../produuzit-client.ts";
import { logger } from "../logger.ts";

export interface ProductionCountEntry {
  batch: string;      // batch uuid
  phase: string;      // production line / phase code
  design: string;     // design uuid
  count: number;      // total production count for this (batch, phase, design)
}

// Read-modify-write the project's meta.quantities so the "Production Counts"
// page reflects our imported counts. Produuzit stores quantities on the project
// object — there is no dedicated endpoint.
// Read the project's current production counts from meta.quantities.
// Returns a Map keyed by `${batch}|${phase}|${design}` → count.
// Signature of the project's counts as they are right now — pass it back to
// upsertProductionCounts to make the write conditional on nothing having changed.
export async function getProductionCountsSignature(projectUuid: string): Promise<string> {
  const project = (await apiGet(`/company/projects/${projectUuid}/`)) as Record<string, any>;
  const meta = (project.meta ?? {}) as Record<string, any>;
  return countsSignature((meta.quantities ?? {}) as Record<string, any>);
}

export async function getProductionCounts(projectUuid: string): Promise<Map<string, number>> {
  const project = (await apiGet(`/company/projects/${projectUuid}/`)) as Record<string, any>;
  const meta = (project.meta ?? {}) as Record<string, any>;
  const quantities = (meta.quantities ?? {}) as Record<string, any>;
  const batchCounts: Record<string, any>[] = Array.isArray(quantities.assd_batch_counts)
    ? quantities.assd_batch_counts
    : [];
  const map = new Map<string, number>();
  for (const b of batchCounts) {
    map.set(`${b.batch}|${b.phase}|${b.design}`, Number(b.count ?? 0));
  }
  return map;
}

// A production count is written ONCE: only for a (batch, phase, design) that
// has no count in Produuzit yet. An existing count is never changed, whatever
// the file says. meta.quantities is not in Produuzit's API spec, so what a
// changed count triggers in the backend is unknown; correcting one is done in
// Produuzit itself. This is also what makes a second run a no-op.
//
// What the preview shows for one (batch, phase, design). Both preview routes
// build their rows here, and upsertProductionCounts applies the same rule.
export function previewCountRow(existing: number, requested: number, definitive: boolean) {
  const status: "new" | "identical" | "kept" | "blocked" = definitive
    ? "blocked"
    : existing === 0
      ? "new"
      : existing === requested
        ? "identical"
        : "kept"; // exists with a different number; left as it is
  return { count_requested: requested, count_existing: existing, status };
}

export function summarizeCountRows(rows: { status: string; count_requested: number }[]) {
  return {
    total: rows.reduce((a, r) => a + (r.count_requested || 0), 0),
    new: rows.filter((r) => r.status === "new").length,
    kept: rows.filter((r) => r.status === "kept").length,
    identical: rows.filter((r) => r.status === "identical").length,
    blocked: rows.filter((r) => r.status === "blocked").length,
  };
}

// Import result rows: "created" for counts written now, "skipped" for counts
// Produuzit already had (and that were therefore left alone).
export function countResults(
  entries: Iterable<ProductionCountEntry & { design_name: string }>,
  kept: (ProductionCountEntry & { existing: number })[],
  batchById: Map<string, Record<string, unknown>>,
): Record<string, unknown>[] {
  const keptByKey = new Map(kept.map((k) => [`${k.batch}|${k.phase}|${k.design}`, k.existing]));
  return [...entries].map((e) => {
    const base = { design_name: e.design_name, batch: (batchById.get(e.batch)?.name as string) ?? e.batch, phase: e.phase, design: e.design };
    const existing = keptByKey.get(`${e.batch}|${e.phase}|${e.design}`);
    if (existing === undefined) return { ...base, status: "created", count: e.count };
    return {
      ...base,
      status: "skipped",
      count: existing,
      reason: existing === e.count
        ? "Count already set"
        : `Count already set to ${existing} in Produuzit (selection says ${e.count}); not changed`,
    };
  });
}

export class ConcurrentModificationError extends Error {
  constructor() {
    super(
      "The project's production counts changed while this import was being prepared. " +
      "Nothing was written. Run the check again so you are confirming current numbers.",
    );
    this.name = "ConcurrentModificationError";
  }
}

function countsSignature(quantities: Record<string, any>): string {
  const rows = Array.isArray(quantities.assd_batch_counts) ? quantities.assd_batch_counts : [];
  return JSON.stringify(
    rows
      .map((b: any) => `${b.batch}|${b.phase}|${b.design}|${Number(b.count ?? 0)}`)
      .sort(),
  );
}

export async function upsertProductionCounts(
  projectUuid: string,
  entries: ProductionCountEntry[],
  // Signature captured when the caller read the counts. When supplied, the write
  // aborts if the project changed in between. Produuzit has no ETag and this is
  // a read-modify-write of the whole project object, so without this a
  // concurrent import silently discarded the other one's counts.
  expectedSignature?: string,
): Promise<{ written: ProductionCountEntry[]; kept: (ProductionCountEntry & { existing: number })[] }> {
  logger.debug(`[production-counts] upsert project=${projectUuid} entries=${entries.length}`);
  const written: ProductionCountEntry[] = [];
  const kept: (ProductionCountEntry & { existing: number })[] = [];

  const project = (await apiGet(`/company/projects/${projectUuid}/`)) as Record<string, any>;
  const meta = (project.meta ?? {}) as Record<string, any>;
  const quantities = (meta.quantities ?? {}) as Record<string, any>;

  if (expectedSignature !== undefined && countsSignature(quantities) !== expectedSignature) {
    throw new ConcurrentModificationError();
  }

  const batchCounts: Record<string, any>[] = Array.isArray(quantities.assd_batch_counts)
    ? quantities.assd_batch_counts
    : [];

  // Index existing rows once so merging N entries is O(N) rather than scanning
  // the whole list per entry.
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < batchCounts.length; i++) {
    const x = batchCounts[i];
    const k = `${x.batch}|${x.phase}|${x.design}`;
    if (!indexByKey.has(k)) indexByKey.set(k, i);
  }
  for (const e of entries) {
    const k = `${e.batch}|${e.phase}|${e.design}`;
    const idx = indexByKey.get(k);
    const existing = idx === undefined ? 0 : Number(batchCounts[idx].count ?? 0);
    if (existing > 0) {
      kept.push({ ...e, existing }); // write-once: see previewCountRow
    } else if (idx !== undefined) {
      batchCounts[idx].count = e.count;
      written.push(e);
    } else {
      indexByKey.set(k, batchCounts.length);
      batchCounts.push({ batch: e.batch, count: e.count, phase: e.phase, design: e.design });
      written.push(e);
    }
  }

  // Nothing new: leave the project object alone entirely, so a repeated run
  // makes no write at all.
  if (!written.length) {
    logger.info(`[production-counts] nothing to write for project=${projectUuid} (${kept.length} already set)`);
    return { written, kept };
  }

  // Recompute phase-level totals from batch counts (one entry per phase × design)
  const phaseMap = new Map<string, { count: number; phase: string; design: string }>();
  for (const b of batchCounts) {
    const key = `${b.phase}|${b.design}`;
    if (!phaseMap.has(key)) phaseMap.set(key, { count: 0, phase: b.phase, design: b.design });
    phaseMap.get(key)!.count += Number(b.count ?? 0);
  }

  quantities.assd_batch_counts = batchCounts;
  quantities.assd_phase_counts = [...phaseMap.values()];
  quantities.modd_batch_counts = quantities.modd_batch_counts ?? [];
  quantities.modd_phase_counts = quantities.modd_phase_counts ?? [];
  meta.quantities = quantities;
  project.meta = meta;

  logger.debug(
    `[production-counts] PUT project=${projectUuid} ` +
    `batch_rows=${batchCounts.length} phase_rows=${quantities.assd_phase_counts.length}`,
  );

  await apiPut(`/company/projects/${projectUuid}/`, project);
  logger.info(`[production-counts] wrote ${written.length} new count(s) to project=${projectUuid}, left ${kept.length} existing`);
  return { written, kept };
}
