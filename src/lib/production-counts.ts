import { apiGet, apiPut } from "../produuzit-client.js";
import { logger } from "../logger.js";

export interface ProductionCountEntry {
  batch: string;      // batch uuid
  phase: string;      // production line / phase code
  design: string;     // design uuid
  count: number;      // total production count for this (batch, phase, design)
}

// Read-modify-write the project's meta.quantities so the "Production Counts"
// page reflects our imported counts. Produuzit stores quantities on the project
// object — there is no dedicated endpoint.
export async function upsertProductionCounts(
  projectUuid: string,
  entries: ProductionCountEntry[],
): Promise<void> {
  logger.debug(`[production-counts] upsert project=${projectUuid} entries=${JSON.stringify(entries)}`);

  const project = (await apiGet(`/company/projects/${projectUuid}/`)) as Record<string, any>;
  const meta = (project.meta ?? {}) as Record<string, any>;
  const quantities = (meta.quantities ?? {}) as Record<string, any>;

  const batchCounts: Record<string, any>[] = Array.isArray(quantities.assd_batch_counts)
    ? quantities.assd_batch_counts
    : [];

  for (const e of entries) {
    const idx = batchCounts.findIndex(
      (x) => x.batch === e.batch && x.design === e.design && x.phase === e.phase,
    );
    if (idx >= 0) {
      batchCounts[idx].count = e.count;
    } else {
      batchCounts.push({ batch: e.batch, count: e.count, phase: e.phase, design: e.design });
    }
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
    `assd_batch_counts=${JSON.stringify(batchCounts)} ` +
    `assd_phase_counts=${JSON.stringify(quantities.assd_phase_counts)}`,
  );

  await apiPut(`/company/projects/${projectUuid}/`, project);
  logger.info(`[production-counts] wrote ${entries.length} count(s) to project=${projectUuid}`);
}
