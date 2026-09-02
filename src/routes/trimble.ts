import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  buildAuthorizeUrl,
  clearTokens,
  exchangeCode,
  fetchAllTrimblePages,
  getCallbackUrls,
  getOAuthState,
  getRefreshToken,
  getRegionEndpoints,
  isAuthenticated,
  markOAuthCompleted,
  restoreRefreshToken,
  setManualToken,
  startOAuthServer,
  stopOAuthServer,
  trimbleGet,
} from "../trimble-client.js";
import { apiGet, apiPatch, apiPost, fetchAllPages } from "../produuzit-client.js";
import * as db from "../db.js";
import { findSource, targetsOf } from "../lib/mapping.js";
import type { ColumnMapping } from "../lib/mapping.js";

const app = new Hono();

const TRIMBLE_COOKIE = "trimble_refresh";
const TRIMBLE_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "Strict" as const,
  path: "/api/trimble",
  maxAge: 90 * 24 * 60 * 60, // 90 days
};

function saveTrimbleCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, TRIMBLE_COOKIE, token, TRIMBLE_COOKIE_OPTS);
}

// Restore refresh token from cookie on every request so the token survives server restarts
app.use("/*", async (c, next) => {
  const saved = getCookie(c, TRIMBLE_COOKIE);
  if (saved) restoreRefreshToken(saved);
  await next();
});

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
  const configuredUrl = c.req.query("callback_url") ?? getCallbackUrls()[0];
  // If a non-localhost callback is configured, use it directly — the /auth/callback route handles it
  if (configuredUrl && !configuredUrl.startsWith("http://localhost")) {
    const url = buildAuthorizeUrl(configuredUrl);
    return c.json({ url, callback_url: configuredUrl });
  }
  // Local dev: start temp TCP server on port 80 and use http://localhost as redirect_uri
  try {
    const port = await startOAuthServer();
    const callbackUrl = `http://localhost`;
    const url = buildAuthorizeUrl(callbackUrl);
    return c.json({ url, callback_port: port, callback_url: callbackUrl });
  } catch (e) {
    // Port 80 blocked (needs admin on Windows) — fall back to manual flow
    const url = buildAuthorizeUrl(configuredUrl);
    return c.json({ url, callback_url: configuredUrl, server_error: String(e) });
  }
});

app.get("/auth/callback-status", (c) => {
  const state = getOAuthState();
  // When the local TCP server completed OAuth, set the cookie now (no HTTP context inside the TCP handler)
  if (state.completed && state.authenticated) {
    const rt = getRefreshToken();
    if (rt) saveTrimbleCookie(c, rt);
  }
  return c.json(state);
});

app.post("/auth/stop-server", (c) => {
  stopOAuthServer();
  return c.json({ ok: true });
});

// Clear tokens + delete cookie — call when refresh token is invalid so the user can re-authenticate
app.post("/auth/disconnect", (c) => {
  clearTokens();
  deleteCookie(c, TRIMBLE_COOKIE, { path: "/api/trimble" });
  return c.json({ ok: true });
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "Missing code parameter" }, 400);
  const redirectUri = c.req.query("redirect_uri") ?? undefined;
  try {
    const tokenData = await exchangeCode(code, redirectUri);
    markOAuthCompleted();
    const rt = tokenData.refresh_token as string | undefined;
    if (rt) saveTrimbleCookie(c, rt);
  } catch (e) {
    markOAuthCompleted(String(e));
    return c.json({ error: String(e) }, 400);
  }
  return c.redirect("/trimble?auth=success");
});

app.post("/auth/exchange-code", async (c) => {
  const body = await c.req.json<{ code: string; redirect_uri?: string }>();
  const code = (body.code ?? "").trim();
  if (!code) return c.json({ error: "Missing code" }, 400);
  try {
    const tokenData = await exchangeCode(code, body.redirect_uri);
    const rt = tokenData.refresh_token as string | undefined;
    if (rt) saveTrimbleCookie(c, rt);
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
  if (body.refresh_token) saveTrimbleCookie(c, body.refresh_token);
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

// GET one entity without field filtering — diagnostic to inspect raw entity structure
app.get("/models/:modelId/entities/sample", async (c) => {
  const modelId = c.req.param("modelId");
  const versionId = c.req.query("versionId") ?? "";
  const endpoints = getRegionEndpoints();
  // fields=psets,psets.name is required to get property-set data + names (API docs requirement)
  const params: Record<string, string> = { top: "1", offset: "0", "fields": "psets,psets.name" };
  if (versionId) params.versionId = versionId;
  const raw = await trimbleGet(endpoints.Model + `models/${modelId}/entities`, params) as Record<string, unknown>;
  // Also fetch psetdefs so we can show resolved names in the sample
  const psetdefsRaw = (await fetchAllTrimblePages(endpoints.Model + `models/${modelId}/psetdefs`, 30000, versionId ? { versionId } : {})) as Record<string, unknown>[];
  const psetDefMap = buildPsetDefMap(psetdefsRaw);
  const items = (raw.items ?? []) as Record<string, unknown>[];
  const transformed = items.map(e => transformEntityPsets(e, psetDefMap));
  return c.json({ raw_first: items[0] ?? null, transformed_first: transformed[0] ?? null, psetdefs_count: psetdefsRaw.length });
});

// Build pset-def lookup: idx → { name, propNames }
function buildPsetDefMap(defs: Record<string, unknown>[]): Map<number, { name: string; propNames: string[] }> {
  const map = new Map<number, { name: string; propNames: string[] }>();
  for (const d of defs) {
    const idx = d.idx as number;
    const name = (d.name ?? "") as string;
    const props = (d.props ?? []) as { name: string }[];
    map.set(idx, { name, propNames: props.map(p => p.name) });
  }
  return map;
}

// Transform entity psets from Trimble's positional-array format to a key-value nested object.
// Trimble format: psets: [{ idx, name, values: [v0, v1, ...] }]
// Output format:  psets: { "PsetName": { "PropName": "value", ... } }
function transformEntityPsets(
  entity: Record<string, unknown>,
  psetDefMap: Map<number, { name: string; propNames: string[] }>,
): Record<string, unknown> {
  const rawPsets = entity.psets as Array<{ idx: number; name?: string; values?: string[] }> | undefined;
  if (!rawPsets || !Array.isArray(rawPsets)) return entity;

  const psetObj: Record<string, Record<string, string>> = {};
  for (const pset of rawPsets) {
    const def = psetDefMap.get(pset.idx);
    const psetName = pset.name ?? def?.name ?? `pset_${pset.idx}`;
    const propNames = def?.propNames ?? [];
    const values = pset.values ?? [];
    const propObj: Record<string, string> = {};
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== null && values[i] !== undefined && values[i] !== "") {
        propObj[propNames[i] ?? String(i)] = String(values[i]);
      }
    }
    psetObj[psetName] = propObj;
  }
  return { ...entity, psets: psetObj };
}

// POST: fetch all entities — cross-references psetdefs to produce key-value pset objects
app.post("/models/:modelId/entities", async (c) => {
  const modelId = c.req.param("modelId");
  const body = await c.req.json<{
    versionId: string;
    fields?: string[] | string;
    filters?: string;
    unique_only?: boolean;
    unique_key_prop?: string;
    include_assemblies?: boolean;
    column_mapping?: ColumnMapping;
  }>();

  if (!body.versionId) return c.json({ error: "Missing versionId" }, 400);

  const endpoints = getRegionEndpoints();
  const extra: Record<string, string> = { versionId: body.versionId };
  // Must request BOTH psets and psets.name — without psets.name the name field is omitted
  // Also request type so we can distinguish physical elements from spatial structure
  extra.fields = "psets,psets.name,type";
  if (body.filters) extra.filters = body.filters;

  // Fetch psetdefs and entities in parallel
  const [rawEntities, psetdefsRaw] = await Promise.all([
    fetchAllTrimblePages(endpoints.Model + `models/${modelId}/entities`, 1000, extra) as Promise<Record<string, unknown>[]>,
    fetchAllTrimblePages(endpoints.Model + `models/${modelId}/psetdefs`, 30000, { versionId: body.versionId }) as Promise<Record<string, unknown>[]>,
  ]);

  const psetDefMap = buildPsetDefMap(psetdefsRaw);
  let entities = rawEntities.map(e => transformEntityPsets(e, psetDefMap));

  // Filter out spatial structure types that are never physical elements.
  // IfcElementAssembly is NOT filtered here — it may represent real assemblies
  // in production models. Use includeAssemblies in the request body to toggle.
  const SPATIAL_TYPES = new Set(["IFCSITE", "IFCBUILDING", "IFCPROJECT", "IFCBUILDINGSTOREY"]);
  const filteredBefore = entities.length;
  entities = entities.filter(e => {
    const tp = (e.type as string || "").toUpperCase();
    if (SPATIAL_TYPES.has(tp)) return false;
    if (tp === "IFCELEMENTASSEMBLY") return body.include_assemblies !== false;
    return true;
  });
  if (entities.length < filteredBefore) {
    console.log(`[trimble] filtered out ${filteredBefore - entities.length} spatial/assembly entities (${filteredBefore} → ${entities.length})`);
  }

  if (entities.length > 0) {
    console.log(`[trimble] entities: ${entities.length} items, psetdefs: ${psetdefsRaw.length}`);
    console.log("[trimble] first entity (transformed):", JSON.stringify(entities[0], null, 2));
    // Log entity type breakdown to help identify spatial/structural elements vs physical elements
    const typeCounts: Record<string, number> = {};
    for (const e of entities) {
      const tp = (e.type as string) || "(no type)";
      typeCounts[tp] = (typeCounts[tp] || 0) + 1;
    }
    console.log("[trimble] entity types:", JSON.stringify(typeCounts, null, 2));
  }

  if (body.unique_only) {
    const keyProp = body.unique_key_prop?.trim() || "";
    const seen = new Set<string>();
    const deduped: Record<string, unknown>[] = [];
    for (const entity of entities) {
      const kv = keyProp ? extractProp(entity, keyProp) : "";
      const key = kv || String(entity.id ?? Math.random());
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
    column_mapping: ColumnMapping;
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

  console.log(`[trimble preview] project=${body.project_uuid}, entities=${entities.length}, designs=${designsMap.size}`);

  // Fetch ALL assemblies once for the project — avoid N per-batch calls
  const allAssemblies = (await fetchAllPages("/constructibles/assemblies/", { project: body.project_uuid, limit: 1000 })) as Record<string, unknown>[];
  // Pre-partition by batch_uuid and by design→batch mapping
  const asmByBatch = new Map<string, Record<string, unknown>[]>();
  const designToBatchUuids = new Map<string, string[]>();
  for (const a of allAssemblies) {
    const bUuid = a.batch as string;
    const dUuid = a.design as string;
    if (bUuid) {
      if (!asmByBatch.has(bUuid)) asmByBatch.set(bUuid, []);
      asmByBatch.get(bUuid)!.push(a);
    }
    if (dUuid && bUuid) {
      if (!designToBatchUuids.has(dUuid)) designToBatchUuids.set(dUuid, []);
      if (!designToBatchUuids.get(dUuid)!.includes(bUuid)) designToBatchUuids.get(dUuid)!.push(bUuid);
    }
  }
  console.log(`[trimble preview] loaded ${allAssemblies.length} assemblies across ${asmByBatch.size} batches`);

  const byBatch = new Map<string, Record<string, unknown>[]>();
  const unresolvedBatches = new Set<string>();
  const unresolvedDesigns = new Set<string>();

  if (!batchProp) {
    for (const entity of entities) {
      const dn = designProp ? extractProp(entity, designProp) : "";
      const designUuid = fuzzyDesignLookup(designsMap, dn) ?? null;
            if (!designUuid) { if (dn) unresolvedDesigns.add(dn); continue; }
            const batchUuids = designToBatchUuids.get(designUuid) ?? [];
            if (!batchUuids.length) { unresolvedDesigns.add(dn); continue; }
      for (const bUuid of batchUuids) {
        if (!byBatch.has(bUuid)) byBatch.set(bUuid, []);
        byBatch.get(bUuid)!.push(entity);
      }
    }
  } else {
    for (const entity of entities) {
      const batchRaw = extractProp(entity, batchProp);
      const matched = batchRaw ? matchBatchByNumber(batches, batchRaw) : null;
      if (!matched) { if (batchRaw) unresolvedBatches.add(batchRaw); continue; }
      const uuid = matched.uuid as string;
      if (!byBatch.has(uuid)) byBatch.set(uuid, []);
      byBatch.get(uuid)!.push(entity);
    }
  }

  const batchPreviews = [];
  let bi = 0;
  for (const [batchUuid, ents] of byBatch) {
    bi++;
    const dbState = dbBatches.get(batchUuid)?.state ?? "provisional";
    const batchName = (batches.find((b) => b.uuid === batchUuid) as Record<string, unknown>)?.name ?? batchUuid;

    // Use pre-partitioned assemblies — no per-batch API call
    const existingAsm = asmByBatch.get(batchUuid) ?? [];
    const existingByKey = new Map<string, Record<string, unknown>>();
    for (const a of existingAsm) {
      const key = trimbleAssemblyKey(a.design as string, a.client_order_id as string | undefined);
      existingByKey.set(key, a);
    }

    const rowPreviews = [];
    for (const entity of ents) {
      const dn = designProp ? extractProp(entity, designProp) : "";
      const designUuid = fuzzyDesignLookup(designsMap, dn) ?? null;
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

    const summary = {
      total: rowPreviews.length,
      new: rowPreviews.filter((r) => r.status === "new").length,
      changed: rowPreviews.filter((r) => r.status === "changed").length,
      identical: rowPreviews.filter((r) => r.status === "identical").length,
      blocked: rowPreviews.filter((r) => r.status === "blocked").length,
    };
    console.log(`[trimble preview] batch ${bi}/${byBatch.size} "${batchName}": ${summary.new}↑ ${summary.changed}~ ${summary.identical}= ${summary.blocked}✗`);

    batchPreviews.push({ batch_uuid: batchUuid, batch_name: batchName, local_state: dbState, blocked: dbState === "definitive", rows: rowPreviews, summary });
  }

  console.log(`[trimble preview] DONE — ${byBatch.size} batches checked, ${unresolvedDesigns.size} unmatched designs, ${unresolvedBatches.size} unmatched batches`);

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
    column_mapping: ColumnMapping;
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

  if (!batchProp) {
    // Design-only mode: route by design name across all batches
    const allAsm = (await fetchAllPages("/constructibles/assemblies/", { project: body.project_uuid, limit: 1000 })) as Record<string, unknown>[];
    const designToBatchUuids = new Map<string, string[]>();
    for (const a of allAsm) {
      const dUuid = a.design as string;
      const bUuid = a.batch as string;
      if (dUuid && bUuid) {
        if (!designToBatchUuids.has(dUuid)) designToBatchUuids.set(dUuid, []);
        if (!designToBatchUuids.get(dUuid)!.includes(bUuid)) designToBatchUuids.get(dUuid)!.push(bUuid);
      }
    }
    for (const entity of entities) {
      const dn = designProp ? extractProp(entity, designProp) : "";
      const designUuid = fuzzyDesignLookup(designsMap, dn) ?? null;
            if (!designUuid) continue;
            for (const bUuid of (designToBatchUuids.get(designUuid) ?? [])) {
        if (!byBatch.has(bUuid)) byBatch.set(bUuid, []);
        byBatch.get(bUuid)!.push(entity);
      }
    }
  } else {
    for (const entity of entities) {
      const batchRaw = extractProp(entity, batchProp);
      const matched = batchRaw ? matchBatchByNumber(batches, batchRaw) : null;
      if (matched) {
        const uuid = matched.uuid as string;
        if (!byBatch.has(uuid)) byBatch.set(uuid, []);
        byBatch.get(uuid)!.push(entity);
      } else if (batchRaw) {
        // Graceful error — record unmatched batch value for notification
        results.push({ design_name: designProp ? extractProp(entity, designProp) : "", batch: batchRaw, status: "error", reason: `No batch named "${batchRaw}" found in project` });
      }
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
      const designUuid = fuzzyDesignLookup(designsMap, dn);
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
    if (val === null || val === undefined) return "";
    if (Array.isArray(val)) {
      const found = val.find((item) => {
        if (typeof item !== "object" || !item) return false;
        const obj = item as Record<string, unknown>;
        return obj.pset_name === p || obj.name === p;
      });
      val = found ?? "";
    } else if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      if (p in obj) {
        val = obj[p];
      } else {
        // Property may be nested under props/properties (object or array)
        const sub = obj.props ?? obj.properties ?? obj.values;
        if (sub && typeof sub === "object") {
          if (Array.isArray(sub)) {
            const found = sub.find((pr) =>
              typeof pr === "string" ? pr === p
                : ((pr as Record<string, unknown>)?.name === p || (pr as Record<string, unknown>)?.propertyName === p)
            );
            val = found === undefined ? ""
              : (typeof found === "string" ? found
                : ((found as Record<string, unknown>)?.value ?? (found as Record<string, unknown>)?.nominalValue ?? ""));
          } else {
            val = (sub as Record<string, unknown>)[p] ?? "";
          }
        } else {
          return "";
        }
      }
    } else {
      return "";
    }
  }
  return val != null ? String(val) : "";
}

function resolveProp(columnMapping: ColumnMapping, target: string): string {
  return findSource(columnMapping, target);
}

function mapIfcRow(entity: Record<string, unknown>, columnMapping: ColumnMapping): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  const clientMeta: Record<string, unknown> = {};
  for (const [ifcPath, targetVal] of Object.entries(columnMapping)) {
    const rawVal = extractProp(entity, ifcPath);
    const val = cleanValue(rawVal);
    for (const target of targetsOf(targetVal)) {
      if (target.startsWith("client_meta.")) {
        clientMeta[target.slice("client_meta.".length)] = val;
      } else if (target && target !== "design_name" && target !== "batch_number") {
        mapped[target] = val;
      }
    }
  }
  if (Object.keys(clientMeta).length) mapped.client_meta = clientMeta;
  return mapped;
}

// Normalize only the 4th character: swap dash/underscore at position 3 (0-indexed).
// This allows A20-EL020 to match A20_EL020, but only at position 3.
function normalizeDesignName(name: string): string {
  if (name.length < 4) return name;
  const chars = name.split('');
  if (chars[3] === '-') { chars[3] = '_'; return chars.join(''); }
  if (chars[3] === '_') { chars[3] = '-'; return chars.join(''); }
  return name;
}

function fuzzyDesignLookup(designsMap: Map<string, string>, name: string): string | null {
  const exact = designsMap.get(name);
  if (exact) return exact;
  const alt = normalizeDesignName(name);
  if (alt !== name) return designsMap.get(alt) ?? null;
  return null;
}

async function loadDesigns(projectUuid: string): Promise<Map<string, string>> {
  const all = (await fetchAllPages("/constructibles/assembly_designs/", { project: projectUuid })) as Record<string, unknown>[];
  const m = new Map<string, string>();
  for (const d of all) {
    const name = d.name as string;
    m.set(name, d.uuid as string);
    // Also index the 4th-char normalized variant so A20-EL020 = A20_EL020
    const alt = normalizeDesignName(name);
    if (alt !== name) m.set(alt, d.uuid as string);
  }
  return m;
}

async function loadBatches(projectUuid: string): Promise<Record<string, unknown>[]> {
  return (await fetchAllPages("/constructibles/batches/", { project: projectUuid })) as Record<string, unknown>[];
}

function matchBatchByNumber(batches: Record<string, unknown>[], batchRaw: string): Record<string, unknown> | null {
  // Strict exact match: entity value must fully match a batch name.
  // "130-vbw" only matches a batch named "130-vbw" (case-insensitive).
  // No partial, prefix, or phase-less fallback matching.
  const raw = String(batchRaw ?? "").trim().toLowerCase();
  if (!raw) return null;
  for (const b of batches) {
    const name = String(b.name ?? "").trim().toLowerCase();
    if (name === raw) return b;
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
