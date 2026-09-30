import { Hono } from "hono";
import { apiGet, apiPost, apiPatch, fetchAllPages } from "../produuzit-client.ts";
import { parseAssemblyCsv } from "../csv-parser.ts";
import { getConfig } from "../config.ts";
import * as db from "../db.ts";
import { findSource, targetsOf, parseCount, normalizeCount } from "../lib/mapping.ts";
import type { ColumnMapping } from "../lib/mapping.ts";
import {
  ConcurrentModificationError,
  getProductionCounts,
  getProductionCountsSignature,
  previewCountRow,
  summarizeCountRows,
  upsertProductionCounts,
} from "../lib/production-counts.ts";
import { GATE, issuePreviewToken, requirePreviewToken } from "../lib/push-gate.ts";
import { boundedInt, isUuid } from "../lib/validate.ts";
import { readUploadedText } from "../lib/upload-limits.ts";
import { loadDesigns, loadBatches, buildBatchMatcher } from "../lib/produuzit-topology.ts";

const app = new Hono();

const NA_PATTERN = /^#?n\/?a$/i;
const WARN_CHARS = /["\\\n\r]/;

// The exact inputs that determine what an import writes. Preview and import must
// build this identically or the fingerprints will not match.
function assemblyGateInput(body: {
  project_uuid: string;
  column_mapping: ColumnMapping;
  rows: Record<string, string>[];
  include_production_counts?: boolean;
  default_count?: number;
}) {
  return {
    project_uuid: body.project_uuid,
    column_mapping: body.column_mapping,
    rows: body.rows,
    include_production_counts: Boolean(body.include_production_counts),
    default_count: normalizeCount(body.default_count),
  };
}

function cleanValue(val: unknown): unknown {
  if (val == null) return null;
  if (typeof val === "string") {
    const v = val.trim();
    if (NA_PATTERN.test(v) || v === "") return null;
    return v;
  }
  return val;
}

function mapRow(
  row: Record<string, string>,
  columnMapping: ColumnMapping,
): { mapped: Record<string, unknown>; warnings: string[] } {
  const mapped: Record<string, unknown> = {};
  const clientMeta: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [csvCol, targetVal] of Object.entries(columnMapping)) {
    const rawVal = row[csvCol];
    const val = cleanValue(rawVal);

    if (typeof val === "string" && WARN_CHARS.test(val)) {
      warnings.push(`Column '${csvCol}' contains special characters that will be escaped.`);
    }

    for (const target of targetsOf(targetVal)) {
      if (target.startsWith("client_meta.")) {
        clientMeta[target.slice("client_meta.".length)] = val;
      } else if (target && target !== "design_name" && target !== "batch_number" && target !== "uuid" && target !== "count") {
        if (target === "client_meta" && typeof val === "string") {
          try { mapped[target] = JSON.parse(val); } catch { mapped[target] = val; }
        } else {
          mapped[target] = val;
        }
      }
    }
  }

  if (Object.keys(clientMeta).length) mapped.client_meta = clientMeta;
  return { mapped, warnings };
}

// Resolve design name → uuid, creating the design in Produuzit when missing
async function resolveDesignUuid(
  designsMap: Map<string, string>,
  projectUuid: string,
  designName: string,
  createdDesigns: Map<string, string>,
): Promise<string | null> {
  const existing = designsMap.get(designName) ?? createdDesigns.get(designName);
  if (existing) return existing;
  try {
    const created = (await apiPost("/constructibles/assembly_designs/", { name: designName, project: projectUuid })) as Record<string, unknown>;
    const uuid = created.uuid as string;
    if (uuid) {
      createdDesigns.set(designName, uuid);
      return uuid;
    }
  } catch {
    // Fall through to null — caller reports the design as unresolved
  }
  return null;
}

// Parse uploaded CSV
app.post("/parse-csv", async (c) => {
  const read = await readUploadedText(c);
  if (read instanceof Response) return read;

  const cfg = getConfig();
  return c.json(parseAssemblyCsv(read.text, cfg.synonyms, cfg.client_meta_defaults));
});

// Load project context (designs + batches) for the column mapper
app.get("/context", async (c) => {
  const projectUuid = c.req.query("project_uuid");
  if (!isUuid(projectUuid)) return c.json({ error: "Missing or invalid project_uuid" }, 400);

  const [designsMap, batches] = await Promise.all([loadDesigns(projectUuid), loadBatches(projectUuid)]);
  const dbBatches = new Map(db.getBatches(projectUuid).map((b) => [b.uuid, b]));

  const batchesEnriched = batches.map((b) => {
    const dbRow = dbBatches.get(b.uuid as string);
    return { ...b, local_state: dbRow?.state ?? "provisional" };
  });

  return c.json({
    designs: [...designsMap.entries()].map(([name, uuid]) => ({ uuid, name })),
    batches: batchesEnriched,
  });
});

// Preview import: resolve designs, group by batch, diff against existing
app.post("/preview-import", async (c) => {
  const body = await c.req.json<{
    project_uuid: string;
    column_mapping: ColumnMapping;
    rows: Record<string, string>[];
    include_production_counts?: boolean;
    default_count?: number;
  }>();

  const defaultCount = normalizeCount(body.default_count);
  const includeCounts = Boolean(body.include_production_counts);

  const designsMap = await loadDesigns(body.project_uuid);
  const batches = await loadBatches(body.project_uuid);
  const dbBatches = new Map(db.getBatches(body.project_uuid).map((b) => [b.uuid, b]));

  const designNameCol = findSource(body.column_mapping, "design_name");
  const batchNumberCol = findSource(body.column_mapping, "batch_number");
  const orderIdCol = findSource(body.column_mapping, "client_order_id");
  const countCol = findSource(body.column_mapping, "count");
  const uuidCol = findSource(body.column_mapping, "uuid");

  // ── UUID mode: update existing assemblies directly by UUID ──
  if (uuidCol) {
    const superprojectCol = findSource(body.column_mapping, "superproject");
    const projectCol = findSource(body.column_mapping, "project");

    // Fetch project info for validation
    let projectInfo: Record<string, unknown> = {};
    try { projectInfo = await apiGet(`/company/projects/${body.project_uuid}/`) as Record<string, unknown>; } catch { /* ignore */ }

    // Fetch all assemblies for this project and build UUID index
    const allAssemblies = await fetchAllPages("/constructibles/assemblies/", { project: body.project_uuid }) as Record<string, unknown>[];
    const byUuid = new Map<string, Record<string, unknown>>();
    for (const a of allAssemblies) byUuid.set(a.uuid as string, a);

    const rowPreviews: Record<string, unknown>[] = [];
    const allWarnings: string[] = [];

    for (const row of body.rows) {
      const uuid = (row[uuidCol] ?? "").trim();
      if (!uuid) {
        rowPreviews.push({ uuid: "", status: "error", reason: "Missing UUID" });
        continue;
      }

      const assembly = byUuid.get(uuid);
      if (!assembly) {
        rowPreviews.push({ uuid, status: "error", reason: "Assembly not found in this project" });
        continue;
      }

      // Validate superproject match
      if (superprojectCol) {
        const csvSuperproject = (row[superprojectCol] ?? "").trim();
        const apiSuperproject = String(projectInfo.super_project ?? "");
        if (csvSuperproject && csvSuperproject !== apiSuperproject) {
          rowPreviews.push({ uuid, status: "error", reason: `Superproject mismatch: CSV '${csvSuperproject}' ≠ project '${apiSuperproject}'` });
          continue;
        }
      }

      // Validate project name match
      if (projectCol) {
        const csvProject = (row[projectCol] ?? "").trim();
        const apiProject = String(projectInfo.name ?? "");
        if (csvProject && csvProject !== apiProject) {
          rowPreviews.push({ uuid, status: "error", reason: `Project mismatch: CSV '${csvProject}' ≠ '${apiProject}'` });
          continue;
        }
      }

      // Map and diff
      const { mapped, warnings } = mapRow(row, body.column_mapping);
      allWarnings.push(...warnings);

      const changed: string[] = [];
      for (const field of ["priority", "client_meta"]) {
        if (field in mapped && JSON.stringify(mapped[field]) !== JSON.stringify(assembly[field])) {
          changed.push(field);
        }
      }

      rowPreviews.push({
        uuid,
        design_name: assembly.design_name,
        client_order_id: assembly.client_order_id,
        status: changed.length ? "changed" : "identical",
        changed_fields: changed,
        proposed: { priority: mapped.priority, client_meta: mapped.client_meta },
        existing: { priority: assembly.priority, client_meta: assembly.client_meta },
      });
    }

    const hasErrors = rowPreviews.some((r) => r.status === "error");

    return c.json({
      uuid_mode: true,
      project_name: projectInfo.name ?? "",
      superproject: projectInfo.super_project ?? "",
      row_previews: rowPreviews,
      has_errors: hasErrors,
      warnings: [...new Set(allWarnings)],
      summary: {
        total: rowPreviews.length,
        changed: rowPreviews.filter((r) => r.status === "changed").length,
        identical: rowPreviews.filter((r) => r.status === "identical").length,
        errors: rowPreviews.filter((r) => r.status === "error").length,
      },
    });
  }

  // ── Standard mode: resolve designs, aggregate production counts by batch ──

  const byBatch = new Map<string, Record<string, string>[]>();
  const unresolvedBatches = new Set<string>();
  const unresolvedDesigns = new Set<string>();
  const createdDesigns = new Map<string, string>();
  const batchById = new Map<string, Record<string, unknown>>();
  for (const b of batches) batchById.set(b.uuid as string, b);
  const existingCounts = await getProductionCounts(body.project_uuid);
  const matchBatch = buildBatchMatcher(batches);

  for (const row of body.rows) {
    const batchNum = batchNumberCol ? (row[batchNumberCol] ?? "") : "";
    const matchedBatch = batchNum ? matchBatch(batchNum) : null;
    if (!matchedBatch) { unresolvedBatches.add(String(batchNum)); continue; }
    const batchUuid = matchedBatch.uuid as string;
    if (!byBatch.has(batchUuid)) byBatch.set(batchUuid, []);
    byBatch.get(batchUuid)!.push(row);
  }

  const batchPreviews = [];

  for (const [batchUuid, rows] of byBatch) {
    const batchInfo = batchById.get(batchUuid) ?? {};
    const dbState = dbBatches.get(batchUuid)?.state ?? "provisional";
    const batchPhase = String(batchInfo.phase ?? "").trim();

    const countMap = new Map<string, { design: string; design_name: string; phase: string; count: number }>();
    for (const row of rows) {
      const designName = designNameCol ? (cleanValue(row[designNameCol]) as string | null) : null;
      const designUuid = designName ? await resolveDesignUuid(designsMap, body.project_uuid, designName, createdDesigns) : null;
      if (designName && !designUuid) { unresolvedDesigns.add(designName); continue; }
      if (!designUuid) continue;
      const count = countCol ? parseCount(cleanValue(row[countCol]), defaultCount) : defaultCount;
      const key = `${batchPhase}|${designUuid}`;
      const entry = countMap.get(key);
      if (entry) entry.count += count;
      else countMap.set(key, { design: designUuid, design_name: designName || designUuid, phase: batchPhase, count });
    }

    const rowPreviews = [...countMap.values()].map((e) => {
      const existing = existingCounts.get(`${batchUuid}|${e.phase}|${e.design}`) ?? 0;
      return {
        design_name: e.design_name,
        design_uuid: e.design,
        phase: e.phase,
        ...previewCountRow(existing, e.count, dbState === "definitive"),
        changed_fields: [],
        proposed: null,
        existing: existing > 0 ? { count: existing } : null,
      };
    });

    batchPreviews.push({
      batch_uuid: batchUuid,
      batch_name: (batchInfo as Record<string, unknown>).name ?? batchUuid,
      local_state: dbState,
      blocked: dbState === "definitive",
      rows: rowPreviews,
      summary: summarizeCountRows(rowPreviews),
    });
  }

  return c.json({
    batch_previews: batchPreviews,
    unresolved_batches: [...unresolvedBatches].sort(),
    unresolved_designs: [...unresolvedDesigns].sort(),
    no_client_order_id: !orderIdCol,
    warnings: [],
    production_counts_included: includeCounts,
    default_count: defaultCount,
    preview_token: issuePreviewToken(GATE.assemblyImport, assemblyGateInput(body)),
  });
});

// Execute import: create new / patch changed / skip identical. Blocks definitive batches.
app.post("/import", async (c) => {
  const body = await c.req.json<{
    project_uuid: string;
    column_mapping: ColumnMapping;
    rows: Record<string, string>[];
    preview_token?: string;
    include_production_counts?: boolean;
    default_count?: number;
  }>();

  const blocked = requirePreviewToken(c, GATE.assemblyImport, body.preview_token, assemblyGateInput(body));
  if (blocked) return blocked;

  const defaultCount = normalizeCount(body.default_count);
  const includeCounts = Boolean(body.include_production_counts);

  // Snapshot the project's counts before doing any work; the write below is
  // conditional on them being unchanged.
  const countsSignature = includeCounts ? await getProductionCountsSignature(body.project_uuid) : null;

  const designsMap = await loadDesigns(body.project_uuid);
  const batches = await loadBatches(body.project_uuid);
  const dbBatches = new Map(db.getBatches(body.project_uuid).map((b) => [b.uuid, b]));

  const designNameCol = findSource(body.column_mapping, "design_name");
  const batchNumberCol = findSource(body.column_mapping, "batch_number");
  const countCol = findSource(body.column_mapping, "count");
  const uuidCol = findSource(body.column_mapping, "uuid");

  // ── UUID mode: bulk-PATCH all assemblies in a single request ──
  if (uuidCol) {
    const results: Record<string, unknown>[] = [];
    const bulkPayload: Record<string, unknown>[] = [];

    for (const row of body.rows) {
      const uuid = (row[uuidCol] ?? "").trim();
      if (!uuid) {
        results.push({ uuid: "", status: "error", reason: "Missing UUID" });
        continue;
      }

      const { mapped } = mapRow(row, body.column_mapping);

      const patchBody: Record<string, unknown> = { uuid };
      if ("priority" in mapped && mapped.priority !== undefined) patchBody.priority = mapped.priority;
      if ("client_meta" in mapped && mapped.client_meta !== undefined) patchBody.client_meta = mapped.client_meta;

      if (Object.keys(patchBody).length === 1) {
        // only "uuid" — nothing to update
        results.push({ uuid, status: "skipped", reason: "No fields to update" });
        continue;
      }

      bulkPayload.push(patchBody);
    }

    if (bulkPayload.length > 0) {
      try {
        const bulkResponse = await apiPost("/constructibles/actuals/bulk_patch/", bulkPayload) as Record<string, unknown>[];
        for (let i = 0; i < bulkResponse.length; i++) {
          const item = bulkResponse[i];
          const uuid = (item.uuid as string) ?? bulkPayload[i]?.uuid ?? `#${i}`;
          const result = (item.result as string) ?? (item.status as string) ?? "";
          if (result === "updated" || result === "patched" || result === "success" || result === "ok") {
            results.push({ uuid, status: "updated" });
          } else if (result === "failed" || result === "error") {
            results.push({ uuid, status: "error", reason: item.detail || item.error || "Bulk patch failed" });
          } else {
            // Unknown result — treat as updated if no error field
            results.push({ uuid, status: item.detail || item.error ? "error" : "updated", reason: item.detail || item.error || undefined });
          }
        }
      } catch (e) {
        // Bulk call itself failed — mark all payload items as errors
        for (const item of bulkPayload) {
          results.push({ uuid: item.uuid, status: "error", reason: String(e) });
        }
      }
    }

    return c.json(results);
  }

  // ── Standard mode: group by batch, match by (design, client_order_id) ──

  const byBatch = new Map<string, Record<string, string>[]>();
  const matchBatch = buildBatchMatcher(batches);
  for (const row of body.rows) {
    const batchNum = batchNumberCol ? (row[batchNumberCol] ?? "") : "";
    const matchedBatch = batchNum ? matchBatch(batchNum) : null;
    if (matchedBatch) {
      const uuid = matchedBatch.uuid as string;
      if (!byBatch.has(uuid)) byBatch.set(uuid, []);
      byBatch.get(uuid)!.push(row);
    }
  }

  const results: Record<string, unknown>[] = [];
  const createdDesigns = new Map<string, string>();
  const batchById = new Map<string, Record<string, unknown>>();
  for (const b of batches) batchById.set(b.uuid as string, b);

  // Aggregate production counts per (batch, phase, design)
  const countMap = new Map<string, { batch: string; phase: string; design: string; design_name: string; count: number }>();

  for (const [batchUuid, rows] of byBatch) {
    const dbState = dbBatches.get(batchUuid)?.state ?? "provisional";
    const batchInfo = batchById.get(batchUuid) ?? {};
    const batchName = (batchInfo.name as string) ?? batchUuid;
    const batchPhase = String(batchInfo.phase ?? "").trim();

    if (dbState === "definitive") {
      for (const row of rows) {
        const dn = designNameCol ? (cleanValue(row[designNameCol]) as string | null) : null;
        results.push({ design_name: dn, batch: batchName, status: "blocked", reason: "Batch is definitive" });
      }
      continue;
    }

    for (const row of rows) {
      const designName = designNameCol ? (cleanValue(row[designNameCol]) as string | null) : null;
      const designUuid = designName ? await resolveDesignUuid(designsMap, body.project_uuid, designName, createdDesigns) : null;
      if (!designUuid) {
        results.push({ design_name: designName, batch: batchName, status: "error", reason: `Design '${designName}' not found in project` });
        continue;
      }
      const count = countCol ? parseCount(cleanValue(row[countCol]), defaultCount) : defaultCount;
      const key = `${batchUuid}|${batchPhase}|${designUuid}`;
      const entry = countMap.get(key);
      if (entry) entry.count += count;
      else countMap.set(key, { batch: batchUuid, phase: batchPhase, design: designUuid, design_name: designName || designUuid, count });
    }
  }

  if (!includeCounts) {
    results.push({ status: "skipped", reason: "Production counts not requested" });
  } else if (countMap.size) {
    try {
      await upsertProductionCounts(body.project_uuid, [...countMap.values()], countsSignature ?? undefined);
      for (const e of countMap.values()) {
        const bn = (batchById.get(e.batch)?.name as string) ?? e.batch;
        results.push({ design_name: e.design_name, batch: bn, phase: e.phase, status: "created", count: e.count });
      }
    } catch (e) {
      if (e instanceof ConcurrentModificationError) {
        return c.json({ error: e.message, code: "CONCURRENT_MODIFICATION" }, 409);
      }
      results.push({ status: "error", reason: `Failed to write production counts: ${String(e)}` });
    }
  }

  return c.json(results);
});

app.get("/", async (c) => {
  const batchUuid = c.req.query("batch_uuid");
  const projectUuid = c.req.query("project_uuid");
  const limit = boundedInt(c.req.query("limit"), 200, 1, 1000);
  const offset = boundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (batchUuid && !isUuid(batchUuid)) return c.json({ error: "Invalid batch_uuid" }, 400);
  if (projectUuid && !isUuid(projectUuid)) return c.json({ error: "Invalid project_uuid" }, 400);

  // Produuzit API does NOT support filtering assemblies by batch or project.
  // Previously this buffered every assembly in the project before filtering,
  // which ran the server out of memory on large projects. Stream page by page
  // and keep only the matches instead.
  if (batchUuid || projectUuid) {
    const params: Record<string, string | number> = {};
    if (batchUuid) params.batch = batchUuid;
    if (projectUuid) params.project = projectUuid;

    const PAGE_SIZE = 200;
    const MAX_PAGES = 500;
    const matched: Record<string, unknown>[] = [];
    let pageOffset = 0;
    let pages = 0;
    while (pages < MAX_PAGES) {
      pages++;
      const page = (await apiGet("/constructibles/assemblies/", {
        ...params,
        limit: PAGE_SIZE,
        offset: pageOffset,
      })) as { results?: Record<string, unknown>[]; next?: string | null };
      const items = page.results ?? [];
      for (const a of items) {
        if (batchUuid && a.batch !== batchUuid) continue;
        if (projectUuid && a.project !== projectUuid) continue;
        matched.push(a);
      }
      if (!page.next || items.length < PAGE_SIZE) break;
      pageOffset += PAGE_SIZE;
    }

    return c.json({
      count: matched.length,
      next: null,
      previous: null,
      results: matched.slice(offset, offset + limit),
    });
  }

  // No filter — pass-through to Produuzit with pagination
  return c.json(await apiGet("/constructibles/assemblies/", { limit, offset }));
});

app.patch("/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  if (!isUuid(uuid)) return c.json({ error: "Invalid assembly uuid" }, 400);
  const body = await c.req.json<Record<string, unknown>>();

  // Only the fields the update screen is allowed to change. Previously the whole
  // request body was forwarded verbatim to Produuzit.
  const ALLOWED = ["scheduled_prod_date", "client_order_id", "priority", "client_meta"] as const;
  const patch: Record<string, unknown> = {};
  for (const k of ALLOWED) if (k in body) patch[k] = body[k];
  if (!Object.keys(patch).length) return c.json({ error: "No updatable fields supplied" }, 400);

  return c.json(await apiPatch(`/constructibles/assemblies/${uuid}/`, patch));
});

export default app;
