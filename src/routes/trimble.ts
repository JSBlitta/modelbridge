import { Hono } from "hono";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchAllTrimblePages,
  getCallbackUrls,
  getOAuthState,
  getRegionEndpoints,
  isAuthenticated,
  setManualToken,
  startOAuthServer,
  stopOAuthServer,
  trimbleGet,
} from "../trimble-client.js";
import { apiGet, apiPatch, apiPost, fetchAllPages } from "../produuzit-client.js";
import * as db from "../db.js";

const app = new Hono();

const NA_PATTERN = /^#?n\/?a$/i;

function cleanValue(val: unknown): unknown {
  if (val == null) return null;
  if (typeof val === "string") {
    const v = val.trim();
    if (NA_PATTERN.test(v) || v === "") return null;
    return v;
  }
  return val;
}

// --- Auth routes ---

app.get("/auth/status", (c) => c.json({ authenticated: isAuthenticated() }));

app.get("/auth/urls", (c) => {
  const urls = getCallbackUrls();
  return c.json({
    callback_urls: urls,
    authorize_urls: urls.map((u) => ({ callback: u, url: buildAuthorizeUrl(u) })),
  });
});

app.get("/auth/start", async (c) => {
  // Start temp TCP server on port 80, then return the authorize URL pointing at http://localhost
  try {
    const port = await startOAuthServer();
    const callbackUrl = `http://localhost`;
    const url = buildAuthorizeUrl(callbackUrl);
    return c.json({ url, callback_port: port, callback_url: callbackUrl });
  } catch (e) {
    // Port 80 likely blocked (needs admin on Windows) — fall back to manual flow
    const callbackUrl = c.req.query("callback_url") ?? getCallbackUrls()[0];
    const url = buildAuthorizeUrl(callbackUrl);
    return c.json({ url, callback_url: callbackUrl, server_error: String(e) });
  }
});

app.get("/auth/callback-status", (c) => c.json(getOAuthState()));

app.post("/auth/stop-server", (c) => {
  stopOAuthServer();
  return c.json({ ok: true });
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "Missing code parameter" }, 400);
  const redirectUri = c.req.query("redirect_uri") ?? undefined;
  try {
    await exchangeCode(code, redirectUri);
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
  return c.redirect("/trimble?auth=success");
});

app.post("/auth/exchange-code", async (c) => {
  const body = await c.req.json<{ code: string; redirect_uri?: string }>();
  const code = (body.code ?? "").trim();
  if (!code) return c.json({ error: "Missing code" }, 400);
  try {
    await exchangeCode(code, body.redirect_uri);
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
  return c.json({ ok: true, authenticated: true });
});

app.post("/auth/token", async (c) => {
  const body = await c.req.json<{ token: string; refresh_token?: string }>();
  const token = (body.token ?? "").trim();
  if (!token) return c.json({ error: "Missing token" }, 400);
  setManualToken(token, body.refresh_token);
  return c.json({ ok: true, authenticated: true });
});

// --- Trimble data routes ---

app.get("/projects", async (c) => {
  const endpoints = getRegionEndpoints();
  return c.json(await trimbleGet(endpoints.Core + "projects", { fullyLoaded: "false", sort: "-name" }));
});

app.get("/projects/:projectId/releases", async (c) => {
  const endpoints = getRegionEndpoints();
  return c.json(await trimbleGet(endpoints.Core + "releases", { projectId: c.req.param("projectId") }));
});

app.get("/releases/:releaseId/files", async (c) => {
  const endpoints = getRegionEndpoints();
  return c.json(await trimbleGet(endpoints.Core + `releases/${c.req.param("releaseId")}/files`));
});

app.get("/projects/:projectId/tree", async (c) => {
  const projectId = c.req.param("projectId");
  const endpoints = getRegionEndpoints();
  let items: Record<string, unknown>[] = [];

  try {
    const rootId = await getProjectRootId(endpoints, projectId);
    if (rootId) items = await walkFolders(endpoints, rootId, "");
  } catch { /* fall through to releases */ }

  if (!items.length) {
    try {
      const rels = await trimbleGet(endpoints.Core + "releases", { projectId });
      const relList = Array.isArray(rels) ? rels : ((rels as Record<string, unknown>).results ?? []) as Record<string, unknown>[];
      for (const rel of relList) {
        try {
          const files = await trimbleGet(endpoints.Core + `releases/${rel.id}/files`);
          const fileList = (Array.isArray(files) ? files : ((files as Record<string, unknown>).results ?? [])) as Record<string, unknown>[];
          for (const f of fileList) {
            f._source = "release";
            f._releaseName = rel.name ?? "";
            items.push(f);
          }
        } catch { /* skip failed release */ }
      }
    } catch { /* no releases */ }
  }

  const ifcItems = items.filter((it) => isIfcFile((it.name as string) ?? (it.filename as string) ?? ""));
  return c.json({ items: ifcItems, total: ifcItems.length });
});

app.get("/models/:modelId/psetdefs", async (c) => {
  const modelId = c.req.param("modelId");
  const versionId = c.req.query("versionId") ?? undefined;
  const endpoints = getRegionEndpoints();
  const extra: Record<string, string> = {};
  if (versionId) extra.versionId = versionId;

  const items = (await fetchAllTrimblePages(endpoints.Model + `models/${modelId}/psetdefs`, 30000, extra)) as Record<string, unknown>[];
  const result = items.map((item) => ({
    name: item.name ?? "",
    properties: item.props ?? item.properties ?? [],
  }));
  return c.json({ psetdefs: result, total: result.length });
});

app.get("/models/:modelId/entities", async (c) => {
  const modelId = c.req.param("modelId");
  const versionId = c.req.query("versionId") ?? "";
  const fields = c.req.query("fields") ?? "";
  const top = c.req.query("top") ?? "1000";
  const offset = c.req.query("offset") ?? "0";
  const filters = c.req.query("filters") ?? undefined;

  const endpoints = getRegionEndpoints();
  const params: Record<string, string> = { versionId, fields, top, offset };
  if (filters) params.filters = filters;
  return c.json(await trimbleGet(endpoints.Model + `models/${modelId}/entities`, params));
});

// POST: fetch all entities paginated (frontend sends body with fields + optional dedup)
app.post("/models/:modelId/entities", async (c) => {
  const modelId = c.req.param("modelId");
  const body = await c.req.json<{
    versionId: string;
    fields: string[] | string;
    filters?: string;
    unique_only?: boolean;
    column_mapping?: Record<string, string>;
  }>();

  if (!body.versionId) return c.json({ error: "Missing versionId" }, 400);
  if (!body.fields) return c.json({ error: "Missing fields" }, 400);

  const fieldsStr = Array.isArray(body.fields) ? body.fields.join(",") : body.fields;
  const endpoints = getRegionEndpoints();

  let entities = (await fetchAllTrimblePages(
    endpoints.Model + `models/${modelId}/entities`,
    1000,
    { versionId: body.versionId, fields: fieldsStr },
  )) as Record<string, unknown>[];

  if (body.unique_only && body.column_mapping) {
    const designProp = resolveProp(body.column_mapping, "design_name");
    const batchProp = resolveProp(body.column_mapping, "batch_number");
    const seen = new Set<string>();
    const deduped: Record<string, unknown>[] = [];
    for (const entity of entities) {
      const key = `${designProp ? extractProp(entity, designProp) : ""}|${batchProp ? extractProp(entity, batchProp) : ""}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(entity); }
    }
    entities = deduped;
  }

  return c.json({ entities, total: entities.length });
});

// --- Trimble → Produuzit import (preview + execute) ---

app.post("/preview-import", async (c) => {
  const body = await c.req.json<{
    project_uuid: string;
    column_mapping: Record<string, string>;
    entities: Record<string, unknown>[];
    unique_only?: boolean;
  }>();

  if (!body.project_uuid) return c.json({ error: "Missing project_uuid" }, 400);
  if (!body.entities?.length) return c.json({ error: "Missing entities" }, 400);

  const designsMap = await loadDesigns(body.project_uuid);
  const batches = await loadBatches(body.project_uuid);
  const dbBatches = new Map(db.getBatches(body.project_uuid).map((b) => [b.uuid, b]));

  const designProp = resolveProp(body.column_mapping, "design_name");
  const batchProp = resolveProp(body.column_mapping, "batch_number");
  const orderProp = resolveProp(body.column_mapping, "client_order_id");

  let entities = body.entities;
  if (body.unique_only) {
    const seen = new Set<string>();
    entities = entities.filter((e) => {
      const key = `${designProp ? extractProp(e, designProp) : ""}|${batchProp ? extractProp(e, batchProp) : ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const byBatch = new Map<string, Record<string, unknown>[]>();
  const unresolvedBatches = new Set<string>();

  for (const entity of entities) {
    const batchRaw = batchProp ? extractProp(entity, batchProp) : "";
    const matched = batchRaw ? matchBatchByNumber(batches, batchRaw) : null;
    if (!matched) { if (batchRaw) unresolvedBatches.add(batchRaw); continue; }
    const uuid = matched.uuid as string;
    if (!byBatch.has(uuid)) byBatch.set(uuid, []);
    byBatch.get(uuid)!.push(entity);
  }

  const batchPreviews = [];
  const unresolvedDesigns = new Set<string>();

  for (const [batchUuid, ents] of byBatch) {
    const dbState = dbBatches.get(batchUuid)?.state ?? "provisional";
    const batchName = (batches.find((b) => b.uuid === batchUuid) as Record<string, unknown>)?.name ?? batchUuid;

    const existingResp = (await apiGet("/constructibles/assemblies/", { batch: batchUuid, limit: 500 })) as {
      results: Record<string, unknown>[];
    };
    // Key on (design, client_order_id) for per-element idempotency
    const existingByKey = new Map<string, Record<string, unknown>>();
    for (const a of existingResp.results ?? []) {
      const key = trimbleAssemblyKey(a.design as string, a.client_order_id as string | undefined);
      existingByKey.set(key, a);
    }

    const rowPreviews = [];
    for (const entity of ents) {
      const dn = designProp ? extractProp(entity, designProp) : "";
      const designUuid = designsMap.get(dn) ?? null;
      if (dn && !designUuid) unresolvedDesigns.add(dn);

      const orderId = orderProp ? extractProp(entity, orderProp) || null : null;
      const mapped = mapIfcRow(entity, body.column_mapping);
      const key = trimbleAssemblyKey(designUuid, orderId);
      const ex = designUuid ? existingByKey.get(key) ?? null : null;
      let status: "new" | "changed" | "identical" | "blocked" = "new";
      const changed: string[] = [];

      if (dbState === "definitive") {
        status = "blocked";
      } else if (ex) {
        for (const field of ["scheduled_prod_date", "priority", "client_meta"]) {
          if (field in mapped && JSON.stringify(mapped[field]) !== JSON.stringify(ex[field])) {
            changed.push(field);
          }
        }
        status = changed.length ? "changed" : "identical";
      }

      rowPreviews.push({ design_name: dn, design_uuid: designUuid, client_order_id: orderId, status, changed_fields: changed, proposed: mapped, existing: ex });
    }

    batchPreviews.push({
      batch_uuid: batchUuid,
      batch_name: batchName,
      local_state: dbState,
      blocked: dbState === "definitive",
      rows: rowPreviews,
      summary: {
        total: rowPreviews.length,
        new: rowPreviews.filter((r) => r.status === "new").length,
        changed: rowPreviews.filter((r) => r.status === "changed").length,
        identical: rowPreviews.filter((r) => r.status === "identical").length,
        blocked: rowPreviews.filter((r) => r.status === "blocked").length,
      },
    });
  }

  return c.json({
    batch_previews: batchPreviews,
    unresolved_batches: [...unresolvedBatches].sort(),
    unresolved_designs: [...unresolvedDesigns].sort(),
  });
});

// Execute import after user reviewed preview
app.post("/import", async (c) => {
  const body = await c.req.json<{
    project_uuid: string;
    column_mapping: Record<string, string>;
    entities: Record<string, unknown>[];
    unique_only?: boolean;
  }>();

  if (!body.project_uuid) return c.json({ error: "Missing project_uuid" }, 400);
  if (!body.entities?.length) return c.json({ error: "Missing entities" }, 400);

  const designsMap = await loadDesigns(body.project_uuid);
  const batches = await loadBatches(body.project_uuid);
  const dbBatches = new Map(db.getBatches(body.project_uuid).map((b) => [b.uuid, b]));

  const designProp = resolveProp(body.column_mapping, "design_name");
  const batchProp = resolveProp(body.column_mapping, "batch_number");
  const orderProp = resolveProp(body.column_mapping, "client_order_id");

  let entities = body.entities;
  if (body.unique_only) {
    const seen = new Set<string>();
    entities = entities.filter((e) => {
      const key = `${designProp ? extractProp(e, designProp) : ""}|${batchProp ? extractProp(e, batchProp) : ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const byBatch = new Map<string, Record<string, unknown>[]>();
  for (const entity of entities) {
    const batchRaw = batchProp ? extractProp(entity, batchProp) : "";
    const matched = batchRaw ? matchBatchByNumber(batches, batchRaw) : null;
    if (matched) {
      const uuid = matched.uuid as string;
      if (!byBatch.has(uuid)) byBatch.set(uuid, []);
      byBatch.get(uuid)!.push(entity);
    }
  }

  const results: Record<string, unknown>[] = [];

  for (const [batchUuid, ents] of byBatch) {
    const dbState = dbBatches.get(batchUuid)?.state ?? "provisional";
    const batchName = (batches.find((b) => b.uuid === batchUuid) as Record<string, unknown>)?.name ?? batchUuid;

    if (dbState === "definitive") {
      for (const e of ents) {
        results.push({ design_name: designProp ? extractProp(e, designProp) : "", batch: batchName, status: "blocked", reason: "Batch is definitive" });
      }
      continue;
    }

    const existingResp = (await apiGet("/constructibles/assemblies/", { batch: batchUuid, limit: 500 })) as {
      results: Record<string, unknown>[];
    };
    const existingByKey = new Map<string, Record<string, unknown>>();
    for (const a of existingResp.results ?? []) {
      const key = trimbleAssemblyKey(a.design as string, a.client_order_id as string | undefined);
      existingByKey.set(key, a);
    }

    for (const entity of ents) {
      const dn = designProp ? extractProp(entity, designProp) : "";
      const designUuid = designsMap.get(dn);
      if (!designUuid) {
        results.push({ design_name: dn, batch: batchName, status: "error", reason: `Design '${dn}' not found` });
        continue;
      }

      const orderId = orderProp ? extractProp(entity, orderProp) || null : null;
      const mapped = mapIfcRow(entity, body.column_mapping);
      mapped.design = designUuid;
      mapped.batch = batchUuid;
      mapped.project = body.project_uuid;
      if (orderId) mapped.client_order_id = orderId;

      const key = trimbleAssemblyKey(designUuid, orderId);
      const ex = existingByKey.get(key);
      if (ex) {
        const changed: string[] = [];
        for (const field of ["scheduled_prod_date", "priority", "client_meta"]) {
          if (field in mapped && JSON.stringify(mapped[field]) !== JSON.stringify(ex[field])) {
            changed.push(field);
          }
        }
        if (!changed.length) {
          results.push({ design_name: dn, client_order_id: orderId, batch: batchName, status: "skipped", reason: "Identical" });
          continue;
        }
        try {
          const patchBody: Record<string, unknown> = {};
          for (const k of changed) if (k in mapped) patchBody[k] = mapped[k];
          await apiPatch(`/constructibles/assemblies/${(ex as Record<string, unknown>).uuid}/`, patchBody);
          results.push({ design_name: dn, client_order_id: orderId, batch: batchName, status: "updated", changed_fields: changed });
        } catch (e) {
          results.push({ design_name: dn, client_order_id: orderId, batch: batchName, status: "error", reason: String(e) });
        }
      } else {
        try {
          await apiPost("/constructibles/assemblies/", mapped);
          results.push({ design_name: dn, client_order_id: orderId, batch: batchName, status: "created" });
        } catch (e) {
          results.push({ design_name: dn, client_order_id: orderId, batch: batchName, status: "error", reason: String(e) });
        }
      }
    }
  }

  const summary = {
    created: results.filter((r) => r.status === "created").length,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    error: results.filter((r) => r.status === "error").length,
  };
  return c.json({ results, summary });
});

// --- Helpers ---

function trimbleAssemblyKey(designUuid: string | null | undefined, clientOrderId: string | null | undefined): string {
  return `${designUuid ?? ""}|${clientOrderId ?? ""}`;
}

function extractProp(entity: Record<string, unknown>, propPath: string): string {
  if (!propPath) return "";
  const parts = propPath.split(".");
  let val: unknown = entity;
  for (const p of parts) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      val = (val as Record<string, unknown>)[p] ?? "";
    } else if (Array.isArray(val)) {
      const found = val.find((item) => {
        if (typeof item !== "object" || !item) return false;
        const obj = item as Record<string, unknown>;
        return obj.pset_name === p || obj.name === p;
      });
      val = found ?? "";
    } else {
      return "";
    }
  }
  return val != null ? String(val) : "";
}

function resolveProp(columnMapping: Record<string, string>, target: string): string {
  for (const [ifcProp, prodTarget] of Object.entries(columnMapping)) {
    if (prodTarget === target) return ifcProp;
  }
  return "";
}

function mapIfcRow(entity: Record<string, unknown>, columnMapping: Record<string, string>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  const clientMeta: Record<string, unknown> = {};
  for (const [ifcPath, target] of Object.entries(columnMapping)) {
    const rawVal = extractProp(entity, ifcPath);
    const val = cleanValue(rawVal);
    if (target.startsWith("client_meta.")) {
      clientMeta[target.slice("client_meta.".length)] = val;
    } else if (target && target !== "design_name" && target !== "batch_number") {
      mapped[target] = val;
    }
  }
  if (Object.keys(clientMeta).length) mapped.client_meta = clientMeta;
  return mapped;
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

function matchBatchByNumber(batches: Record<string, unknown>[], batchNumber: string): Record<string, unknown> | null {
  const num = parseInt(String(batchNumber).trim(), 10);
  if (isNaN(num)) return null;
  for (const b of batches) {
    const name = (b.name as string) ?? "";
    if (new RegExp(`^${num}[^0-9]`).test(name) || name === String(num)) return b;
  }
  return null;
}

function isIfcFile(filename: string): boolean {
  const n = filename.toLowerCase();
  return n.endsWith(".ifc") || n.endsWith(".ifczip") || n.endsWith(".ifcxml");
}

async function getProjectRootId(endpoints: Record<string, string>, projectId: string): Promise<string> {
  const proj = (await trimbleGet(endpoints.Core + `projects/${projectId}`)) as Record<string, unknown>;
  return (proj.rootId as string) ?? (proj.id as string) ?? "";
}

async function walkFolders(
  endpoints: Record<string, string>,
  folderId: string,
  parentPath: string,
  depth = 0,
): Promise<Record<string, unknown>[]> {
  if (depth > 20) return [];
  const items: Record<string, unknown>[] = [];
  let contents: unknown;
  try {
    contents = await trimbleGet(endpoints.Core + `folders/${folderId}/items`);
  } catch {
    return [];
  }

  const itemList = Array.isArray(contents) ? contents : ((contents as Record<string, unknown>).results ?? []) as Record<string, unknown>[];

  for (const item of itemList) {
    const itemType = String(item.type ?? "").toLowerCase();
    const name = (item.name as string) ?? "";
    const currentPath = parentPath ? `${parentPath}/${name}` : name;

    if (itemType === "folder") {
      const subId = (item.id as string) ?? "";
      if (subId && subId !== folderId) {
        items.push(...(await walkFolders(endpoints, subId, currentPath, depth + 1)));
      }
    } else if (itemType === "file" && isIfcFile(name)) {
      item._parent = parentPath;
      items.push(item);
    }
  }
  return items;
}

export default app;
