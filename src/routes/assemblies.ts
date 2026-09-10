import { Hono } from "hono";
import { apiGet, apiPost, apiPatch, fetchAllPages } from "../produuzit-client.js";
import { parseAssemblyCsv } from "../csv-parser.js";
import { getConfig } from "../config.js";
import * as db from "../db.js";
import { findSource, targetsOf, parseCount, generateOrderIds } from "../lib/mapping.js";
import type { ColumnMapping } from "../lib/mapping.js";
import {
  ConcurrentModificationError,
  getProductionCounts,
  getProductionCountsSignature,
  upsertProductionCounts,
} from "../lib/production-counts.js";
import { GATE, issuePreviewToken, requirePreviewToken } from "../lib/push-gate.js";
import { boundedInt, isUuid } from "../lib/validate.js";

const app = new Hono();

const NA_PATTERN = /^#?n\/?a$/i;
const WARN_CHARS = /["\\\n\r]/;

// Ask Produuzit to filter by project, then narrow to the batch locally.
//
// The previous version passed no params at all and pulled every assembly in the
// company on each preview and create. That contradicted the rest of this file
// (and trimble.ts), which all pass `project` and depend on it working; the
// client-side filter below stays as a belt-and-braces narrowing in case the
// upstream filter is ignored.
async function fetchAssembliesByBatch(
  batchUuid: string,
  projectUuid?: string,
): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {};
  if (projectUuid) params.project = projectUuid;
  const all = (await fetchAllPages("/constructibles/assemblies/", params)) as Record<string, unknown>[];
  return all.filter((a) => a.batch === batchUuid);
}

// The exact inputs that determine what an import writes. Preview and import must
// build this identically or the fingerprints will not match.
function assemblyGateInput(body: {
  project_uuid: string;
  column_mapping: ColumnMapping;
  rows: Record<string, string>[];
}) {
  return {
    project_uuid: body.project_uuid,
    column_mapping: body.column_mapping,
    rows: body.rows,
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

async function loadDesigns(projectUuid: string): Promise<Map<string, string>> {
  const all = (await fetchAllPages("/constructibles/assembly_designs/", { project: projectUuid })) as Record<string, unknown>[];
  const m = new Map<string, string>();
  for (const d of all) m.set(d.name as string, d.uuid as string);
  return m;
}

async function loadBatches(projectUuid: string): Promise<Record<string, unknown>[]> {
  return (await fetchAllPages("/constructibles/batches/", { project: projectUuid })) as Record<string, unknown>[];
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
  } catch (e) {
    // Fall through to null — caller reports the design as unresolved
  }
  return null;
}

function matchBatchByNumber(batches: Record<string, unknown>[], batchRaw: string): Record<string, unknown> | null {
  // Strict exact match: entity value must fully match a batch name.
  const raw = String(batchRaw ?? "").trim().toLowerCase();
  if (!raw) return null;
  for (const b of batches) {
    const name = String(b.name ?? "").trim().toLowerCase();
    if (name === raw) return b;
  }
  return null;
}

// Parse uploaded CSV
app.post("/parse-csv", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) return c.json({ error: "No file uploaded" }, 400);

  const buffer = await file.arrayBuffer();
  const decoder = new TextDecoder("utf-8");
  let text = decoder.decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const cfg = getConfig();
  const result = parseAssemblyCsv(text, cfg.synonyms, cfg.client_meta_defaults);
  return c.json(result);
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
  }>();

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

  for (const row of body.rows) {
    const batchNum = batchNumberCol ? (row[batchNumberCol] ?? "") : "";
    const matchedBatch = batchNum ? matchBatchByNumber(batches, batchNum) : null;
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
      const count = countCol ? parseCount(cleanValue(row[countCol])) : 1;
      const key = `${batchPhase}|${designUuid}`;
      const entry = countMap.get(key);
      if (entry) entry.count += count;
      else countMap.set(key, { design: designUuid, design_name: designName || designUuid, phase: batchPhase, count });
    }

    const rowPreviews = [...countMap.values()].map((e) => {
      const existing = existingCounts.get(`${batchUuid}|${e.phase}|${e.design}`) ?? 0;
      let status: "new" | "changed" | "identical" | "blocked" = "new";
      let countToCreate = e.count;
      if (dbState === "definitive") {
        status = "blocked";
        countToCreate = 0;
      } else if (existing >= e.count) {
        status = "identical";
        countToCreate = 0;
      } else if (existing > 0) {
        status = "changed";
        countToCreate = e.count - existing;
      }
      return {
        design_name: e.design_name,
        design_uuid: e.design,
        phase: e.phase,
        count_requested: e.count,
        count_existing: existing,
        count_to_create: countToCreate,
        status,
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
      summary: {
        total: rowPreviews.reduce((a, r) => a + (r.count_requested || 0), 0),
        new: rowPreviews.filter((r) => r.status === "new").reduce((a, r) => a + (r.count_to_create || 0), 0),
        changed: rowPreviews.filter((r) => r.status === "changed").reduce((a, r) => a + (r.count_to_create || 0), 0),
        identical: rowPreviews.filter((r) => r.status === "identical").length,
      },
    });
  }

  return c.json({
    batch_previews: batchPreviews,
    unresolved_batches: [...unresolvedBatches].sort(),
    unresolved_designs: [...unresolvedDesigns].sort(),
    no_client_order_id: !orderIdCol,
    warnings: [],
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
  }>();

  const blocked = requirePreviewToken(c, GATE.assemblyImport, body.preview_token, assemblyGateInput(body));
  if (blocked) return blocked;

  // Snapshot the project's counts before doing any work; the write below is
  // conditional on them being unchanged.
  const countsSignature = await getProductionCountsSignature(body.project_uuid);

  const designsMap = await loadDesigns(body.project_uuid);
  const batches = await loadBatches(body.project_uuid);
  const dbBatches = new Map(db.getBatches(body.project_uuid).map((b) => [b.uuid, b]));

  const designNameCol = findSource(body.column_mapping, "design_name");
  const batchNumberCol = findSource(body.column_mapping, "batch_number");
  const orderIdCol = findSource(body.column_mapping, "client_order_id");
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
  for (const row of body.rows) {
    const batchNum = batchNumberCol ? (row[batchNumberCol] ?? "") : "";
    const matchedBatch = batchNum ? matchBatchByNumber(batches, batchNum) : null;
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
      const count = countCol ? parseCount(cleanValue(row[countCol])) : 1;
      const key = `${batchUuid}|${batchPhase}|${designUuid}`;
      const entry = countMap.get(key);
      if (entry) entry.count += count;
      else countMap.set(key, { batch: batchUuid, phase: batchPhase, design: designUuid, design_name: designName || designUuid, count });
    }
  }

  if (countMap.size) {
    try {
      await upsertProductionCounts(body.project_uuid, [...countMap.values()], countsSignature);
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
  // If a filter is requested, fetch all assemblies and filter client-side.
  if (batchUuid || projectUuid) {
    const params: Record<string, string | number> = {};
    if (batchUuid) params.batch = batchUuid;
    if (projectUuid) params.project = projectUuid;
    const all = await fetchAllPages("/constructibles/assemblies/", params) as Record<string, unknown>[];
    const filtered = all.filter((a) => {
      if (batchUuid && a.batch !== batchUuid) return false;
      if (projectUuid && a.project !== projectUuid) return false;
      return true;
    });
    return c.json({
      count: filtered.length,
      next: null,
      previous: null,
      results: filtered.slice(offset, offset + limit),
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

// --- Count-based constructible creation ---
// Each physical element in Produuzit is its own Assembly (constructible) with a unique UUID.
// "Production count" means: create N assemblies for a given design, each with a unique client_order_id.

interface CountItem {
  design_uuid: string;
  design_name: string;
  count: number;
  order_prefix?: string;     // prefix for auto-generated order IDs, e.g. "A20-EL" → A20-EL-001
  scheduled_prod_date?: string;
  priority?: number;
  client_meta?: Record<string, unknown>;
}

function countGateInput(body: { batch_uuid: string; items: CountItem[] }) {
  return { batch_uuid: body.batch_uuid, items: body.items };
}

// Preview: shows existing count, how many will be created, and the order IDs that will be used
app.post("/preview-by-count", async (c) => {
  const body = await c.req.json<{ batch_uuid: string; project_uuid?: string; items: CountItem[] }>();
  if (!isUuid(body.batch_uuid)) return c.json({ error: "Missing or invalid batch_uuid" }, 400);

  const existing = await fetchAssembliesByBatch(body.batch_uuid, body.project_uuid);

  const previews = body.items.map((item) => {
    const existingForDesign = existing.filter((a) => a.design === item.design_uuid);
    const existingIds = existingForDesign.map((a) => a.client_order_id as string).filter(Boolean);
    const prefix = (item.order_prefix || item.design_name).replace(/\s+/g, "-");
    const toCreate = Math.max(0, item.count - existingForDesign.length);
    const nextStart = existingForDesign.length + 1;
    const newIds = generateOrderIds(prefix, nextStart, toCreate);

    return {
      design_uuid: item.design_uuid,
      design_name: item.design_name,
      count_requested: item.count,
      count_existing: existingForDesign.length,
      count_to_create: toCreate,
      existing_order_ids: existingIds,
      new_order_ids: newIds,
      order_prefix: prefix,
    };
  });

  return c.json({
    batch_uuid: body.batch_uuid,
    previews,
    preview_token: issuePreviewToken(GATE.countCreate, countGateInput(body)),
  });
});

// Execute: creates exactly count_to_create assemblies per design
app.post("/create-by-count", async (c) => {
  const body = await c.req.json<{
    batch_uuid: string;
    project_uuid: string;
    items: CountItem[];
    preview_token?: string;
  }>();
  if (!body.batch_uuid || !body.project_uuid) return c.json({ error: "Missing batch_uuid or project_uuid" }, 400);

  const blocked = requirePreviewToken(c, GATE.countCreate, body.preview_token, countGateInput(body));
  if (blocked) return blocked;

  const existing = await fetchAssembliesByBatch(body.batch_uuid, body.project_uuid);

  const results: Record<string, unknown>[] = [];

  for (const item of body.items) {
    const existingForDesign = existing.filter((a) => a.design === item.design_uuid);
    const toCreate = Math.max(0, item.count - existingForDesign.length);
    const prefix = (item.order_prefix || item.design_name).replace(/\s+/g, "-");
    const nextStart = existingForDesign.length + 1;
    const newIds = generateOrderIds(prefix, nextStart, toCreate);

    for (const orderId of newIds) {
      try {
        const payload: Record<string, unknown> = {
          design: item.design_uuid,
          batch: body.batch_uuid,
          project: body.project_uuid,
          client_order_id: orderId,
        };
        if (item.scheduled_prod_date) payload.scheduled_prod_date = item.scheduled_prod_date;
        if (item.priority !== undefined) payload.priority = item.priority;
        if (item.client_meta) payload.client_meta = item.client_meta;

        await apiPost("/constructibles/assemblies/", payload);
        results.push({ design_name: item.design_name, client_order_id: orderId, status: "created" });
      } catch (e) {
        results.push({ design_name: item.design_name, client_order_id: orderId, status: "error", reason: String(e) });
      }
    }

    if (toCreate === 0) {
      results.push({ design_name: item.design_name, status: "skipped", reason: `Already at count ${item.count}` });
    }
  }

  return c.json({
    results,
    summary: {
      created: results.filter((r) => r.status === "created").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      error: results.filter((r) => r.status === "error").length,
    },
  });
});

export default app;
