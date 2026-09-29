import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import { getSettings } from "../settings.ts";
import {
  beginOAuth,
  clearTokens,
  exchangeCode,
  fetchAllTrimblePages,
  fetchProjectPsetLibraries,
  fetchProjectPsetCatalog,
  fetchEntityPsets,
  type ProjectPsetInstance,
  getCallbackUrls,
  getOAuthState,
  getRegionEndpoints,
  isAuthenticated,
  isConfiguredCallback,
  markOAuthCompleted,
  redeemOAuthState,
  runAsUser,
  setManualToken,
  trimbleGet,
} from "../trimble-client.ts";
import { apiGet, apiPatch, apiPost, fetchAllPages } from "../produuzit-client.ts";
import * as db from "../db.ts";
import { findSource, parseCount, normalizeCount } from "../lib/mapping.ts";
import type { ColumnMapping } from "../lib/mapping.ts";
import {
  ConcurrentModificationError,
  getProductionCounts,
  getProductionCountsSignature,
  upsertProductionCounts,
} from "../lib/production-counts.ts";
import { logger } from "../logger.ts";
import { GATE, issuePreviewToken, requirePreviewToken } from "../lib/push-gate.ts";
import { isOpaqueId } from "../lib/validate.ts";
import { loadDesigns, loadBatches, fuzzyDesignLookup, buildBatchMatcher } from "../lib/produuzit-topology.ts";

const app = new Hono();

// The refresh token used to live in this browser cookie and was loaded into a
// process-wide slot, which made one user's Trimble connection everyone's. Tokens
// are now per user in state.db; an old cookie is only cleared, never trusted,
// because on a shared PC it may belong to whoever was logged in before.
const LEGACY_TRIMBLE_COOKIE = "trimble_refresh";

// Every Trimble call below runs as the logged-in user. The OAuth callback is the
// one route without a session; it switches to the flow's owner itself.
app.use("/*", async (c, next) => {
  if (getCookie(c, LEGACY_TRIMBLE_COOKIE)) deleteCookie(c, LEGACY_TRIMBLE_COOKIE, { path: "/api/trimble" });
  const session = c.get("session");
  if (!session) return next();
  return runAsUser(session.username, next);
});

// --- Auth routes ---

app.get("/auth/status", (c) => c.json({ authenticated: isAuthenticated() }));

app.get("/auth/urls", (c) => {
  const urls = getCallbackUrls();
  // Each URL gets its own single-use state, so any of them can be started.
  return c.json({
    callback_urls: urls,
    authorize_urls: urls.map((u) => ({ callback: u, url: beginOAuth(u).url })),
  });
});

app.get("/auth/start", (c) => {
  // The callback must be one we were configured with; an arbitrary value from
  // the query string is not accepted.
  const requested = c.req.query("callback_url");
  const callbackUrl = isConfiguredCallback(requested) ? requested : getCallbackUrls()[0];
  if (!callbackUrl) {
    return c.json({ error: "No Trimble callback URL is configured (TRIMBLE_CALLBACK_URLS)" }, 500);
  }
  const { url } = beginOAuth(callbackUrl);
  return c.json({ url, callback_url: callbackUrl });
});

app.get("/auth/callback-status", (c) => {
  return c.json(getOAuthState());
});

// Clears this user's tokens only — call when the refresh token is invalid so they can re-authenticate
app.post("/auth/disconnect", (c) => {
  clearTokens();
  return c.json({ ok: true });
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "Missing code parameter" }, 400);

  // The state proves this callback belongs to a flow we started, and carries the
  // redirect_uri we started it with. Both used to be attacker-controlled.
  // It also names the user who started the flow: the token lands in their slot.
  const flow = redeemOAuthState(c.req.query("state"));
  if (!flow) {
    return c.json({ error: "Invalid or expired authentication attempt. Start the connection again." }, 400);
  }

  return runAsUser(flow.username, async () => {
    try {
      await exchangeCode(code, flow.redirectUri);
      markOAuthCompleted();
      logger.info(`[trimble] connected for "${flow.username}"`);
    } catch (e) {
      markOAuthCompleted(String(e));
      return c.json({ error: String(e) }, 400);
    }
    return c.redirect("/trimble?auth=success");
  });
});

app.post("/auth/exchange-code", async (c) => {
  const body = await c.req.json<{ code: string; redirect_uri?: string }>();
  const code = (body.code ?? "").trim();
  if (!code) return c.json({ error: "Missing code" }, 400);
  // Manual paste-the-code fallback. Session-gated like every other route, and
  // the redirect_uri still has to be one we know about.
  const redirectUri = isConfiguredCallback(body.redirect_uri)
    ? body.redirect_uri
    : getCallbackUrls()[0];
  try {
    await exchangeCode(code, redirectUri);
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
//
// Project ids, model ids and library ids are extremely stable, so this topology
// is cached in SQLite and served from there indefinitely. It is only refreshed
// when the cache misses or an admin explicitly forces it (?refresh=1).

function wantsRefresh(c: { req: { query: (k: string) => string | undefined } }): boolean {
  const v = c.req.query("refresh");
  return v === "1" || v === "true";
}

function toItemList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const p = raw as Record<string, unknown>;
    return (p.results ?? p.items ?? []) as Record<string, unknown>[];
  }
  return [];
}

// Read-through SQLite cache. Serve the cached JSON unless the caller asked to
// refresh; otherwise load fresh, persist the result and return it.
async function cachedJson(c: Context, key: string, load: () => Promise<unknown>) {
  if (!wantsRefresh(c)) {
    const hit = db.getTrimbleCache(key);
    if (hit) return c.json(hit.value);
  }
  const value = await load();
  db.setTrimbleCache(key, value);
  return c.json(value);
}

app.get("/projects", async (c) => {
  return cachedJson(c, "projects", async () => {
    const endpoints = getRegionEndpoints();
    const raw = await trimbleGet(endpoints.Core + "projects", { fullyLoaded: "false", sort: "-name" });
    const projects = toItemList(raw)
      .map((p) => ({
        project_id: String(p.id ?? p.projectId ?? ""),
        name: (p.name as string) ?? null,
        raw: p,
      }))
      .filter((p) => p.project_id);
    db.upsertTrimbleProjects(projects);
    return raw;
  });
});

app.get("/projects/:projectId/releases", async (c) => {
  const projectId = c.req.param("projectId");
  if (!isOpaqueId(projectId)) return c.json({ error: "Invalid projectId" }, 400);
  const endpoints = getRegionEndpoints();
  return c.json(await trimbleGet(endpoints.Core + "releases", { projectId }));
});

app.get("/releases/:releaseId/files", async (c) => {
  const releaseId = c.req.param("releaseId");
  if (!isOpaqueId(releaseId)) return c.json({ error: "Invalid releaseId" }, 400);
  const endpoints = getRegionEndpoints();
  return c.json(await trimbleGet(endpoints.Core + `releases/${releaseId}/files`));
});


app.get("/projects/:projectId/tree", async (c) => {
  const projectId = c.req.param("projectId");
  if (!isOpaqueId(projectId)) return c.json({ error: "Invalid projectId" }, 400);
  return cachedJson(c, `tree:${projectId}`, async () => {
    const endpoints = getRegionEndpoints();
    let items: Record<string, unknown>[] = [];

    try {
      const rootId = await getProjectRootId(endpoints, projectId);
      if (rootId) items = await walkFolders(endpoints, rootId, "");
    } catch { /* fall through to releases */ }

    if (!items.length) {
      try {
        const rels = await trimbleGet(endpoints.Core + "releases", { projectId });
        // Sequential on purpose: a project can have many releases and buffering
        // all of their file lists at once is an easy way to exhaust memory.
        for (const rel of toItemList(rels)) {
          try {
            const files = await trimbleGet(endpoints.Core + `releases/${rel.id}/files`);
            for (const f of toItemList(files)) {
              f._source = "release";
              f._releaseName = rel.name ?? "";
              items.push(f);
            }
          } catch { /* skip failed release */ }
        }
      } catch { /* no releases */ }
    }

    const ifcItems = items.filter((it) => isIfcFile((it.name as string) ?? (it.filename as string) ?? ""));
    // Persist the discovered models so model -> library links can be formed even
    // when the libraries endpoint is called before the tree.
    db.upsertTrimbleModels(projectId, ifcItems
      .map((it) => ({
        model_id: String(it.id ?? ""),
        name: (it.name as string) ?? (it.filename as string) ?? null,
        raw: it,
      }))
      .filter((m) => m.model_id));
    return { items: ifcItems, total: ifcItems.length };
  });
});

// Pset libraries attached to a project, plus which of the project's cached
// models each library maps to. Libraries live on the Organizer discovery tree.
// Only the library ids are cached (with the model links); the library's property
// definitions are fetched live by /pset-catalog.
app.get("/projects/:projectId/libraries", async (c) => {
  const projectId = c.req.param("projectId");
  if (!isOpaqueId(projectId)) return c.json({ error: "Invalid projectId" }, 400);
  return cachedJson(c, `libraries:${projectId}`, async () => {
    const libs = await fetchProjectPsetLibraries(projectId);
    db.replaceTrimbleProjectLibraries(projectId, libs.map((l) => ({ library_id: l.library_id, name: l.name, raw: l.raw })));

    const modelLibs = db.getTrimbleModelLibraries();
    return {
      libraries: db.getTrimbleLibraries(projectId).map((l) => ({ library_id: l.library_id, name: l.name })),
      models: db.getTrimbleModels(projectId).map((m) => ({
        model_id: m.model_id,
        name: m.name,
        library_ids: modelLibs.filter((ml) => ml.model_id === m.model_id).map((ml) => ml.library_id),
      })),
    };
  });
});

// Project property-set definitions from the PSet service. These are the
// Trimble-added psets (not present in the IFC). Property data is always fetched
// live — only the library/model/project ids are cached.
app.get("/projects/:projectId/pset-catalog", async (c) => {
  const projectId = c.req.param("projectId");
  if (!isOpaqueId(projectId)) return c.json({ error: "Invalid projectId" }, 400);
  const { libraries, definitions } = await fetchProjectPsetCatalog(projectId);
  return c.json({
    libraries: libraries.map((l) => ({ library_id: l.library_id, name: l.name })),
    definitions,
  });
});

app.get("/models/:modelId/psetdefs", async (c) => {
  const modelId = c.req.param("modelId");
  if (!isOpaqueId(modelId)) return c.json({ error: "Invalid modelId" }, 400);
  const versionId = c.req.query("versionId") ?? undefined;
  const endpoints = getRegionEndpoints();
  const extra: Record<string, string> = {};
  if (versionId) extra.versionId = versionId;

  // IFC property definitions are always fetched live.
  const items = (await fetchAllTrimblePages(endpoints.Model + `models/${modelId}/psetdefs`, 30000, extra)) as Record<string, unknown>[];
  const result = items.map((item) => ({
    name: item.name ?? "",
    properties: item.props ?? item.properties ?? [],
  }));
  return c.json({ psetdefs: result, total: result.length });
});

app.get("/models/:modelId/entities", async (c) => {
  const modelId = c.req.param("modelId");
  if (!isOpaqueId(modelId)) return c.json({ error: "Invalid modelId" }, 400);
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
  if (!isOpaqueId(modelId)) return c.json({ error: "Invalid modelId" }, 400);
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
  if (!isOpaqueId(modelId)) return c.json({ error: "Invalid modelId" }, 400);
  const body = await c.req.json<{
    versionId: string;
    fields?: string[] | string;
    filters?: string;
    entity_text_filter?: string;
    unique_only?: boolean;
    unique_key_prop?: string;
    include_assemblies?: boolean;
    column_mapping?: ColumnMapping;
    project_id?: string;
  }>();

  if (!body.versionId) return c.json({ error: "Missing versionId" }, 400);

  const endpoints = getRegionEndpoints();
  const extra: Record<string, string> = { versionId: body.versionId };
  // Must request BOTH psets and psets.name — without psets.name the name field is omitted
  // Also request type so we can distinguish physical elements from spatial structure
  // idc is the connect identifier: pset links (frn:entity:...) may reference it
  // rather than the source id, so fetch both to match Trimble-added properties.
  extra.fields = "idc,psets,psets.name,type";
  if (body.filters) extra.filters = body.filters;
  // Server-side free-text filter (entity class, product name, pset names/values).
  // 'CalculatedGeometryValues' keeps only entities that carry geometry — the
  // fallback for models polluted with geometry-less catalog/type entities.
  // Precedence: request body > persisted setting (seeded from the env var).
  const entityTextFilter =
    body.entity_text_filter?.trim() || String(getSettings().trimble_entity_text_filter ?? "").trim();
  if (entityTextFilter) extra.text = entityTextFilter;

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
    logger.debug(`[trimble] filtered out ${filteredBefore - entities.length} spatial/assembly entities (${filteredBefore} → ${entities.length})`);
  }

  if (entities.length > 0) {
    logger.debug(`[trimble] entities: ${entities.length} items, psetdefs: ${psetdefsRaw.length}`);
    // Log entity type breakdown to help identify spatial/structural elements vs physical elements
    const typeCounts: Record<string, number> = {};
    for (const e of entities) {
      const tp = (e.type as string) || "(no type)";
      typeCounts[tp] = (typeCounts[tp] || 0) + 1;
    }
    logger.debug("[trimble] entity types:", JSON.stringify(typeCounts, null, 2));
  }

  if (body.unique_only) {
    const keyProp = body.unique_key_prop?.trim() || "";
    const seen = new Set<string>();
    const deduped: Record<string, unknown>[] = [];
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const kv = keyProp ? extractProp(entity, keyProp) : "";
      // No key prop and no id means we cannot tell two entities apart. Fall back
      // to positional identity so the result is at least deterministic —
      // Math.random() here silently made unique_only a no-op.
      const key = kv || (entity.id != null ? String(entity.id) : `#${i}`);
      if (!seen.has(key)) { seen.add(key); deduped.push(entity); }
    }
    entities = deduped;
  }

  // Merge properties added through Trimble Connect. They live in the PSet
  // service, not the IFC, so the model API's `psets` field omits them entirely —
  // without this they never appear in the Trimble flow.
  if (body.project_id && isOpaqueId(body.project_id) && entities.length) {
    try {
      const entityGuids = entities
        .map((e) => [e.id, e.idc, e.entityId].filter((v) => v != null).map(String)[0])
        .filter((guid): guid is string => Boolean(guid));
      const instances = await fetchEntityPsets(entityGuids, { projectId: body.project_id });
      if (instances.length) {
        const byEntity = new Map<string, ProjectPsetInstance[]>();
        for (const inst of instances) {
          const list = byEntity.get(inst.entity_id);
          if (list) list.push(inst);
          else byEntity.set(inst.entity_id, [inst]);
        }
        let merged = 0;
        for (const e of entities) {
          const candidates = [e.id, e.idc, e.entityId].filter((v) => v != null).map((v) => String(v));
          let list: ProjectPsetInstance[] | undefined;
          for (const c of candidates) {
            list = byEntity.get(c);
            if (list) break;
          }
          if (!list) continue;
          const psets = (e.psets && typeof e.psets === "object" && !Array.isArray(e.psets))
            ? (e.psets as Record<string, unknown>)
            : {};
          for (const inst of list) {
            const target = (psets[inst.def_name] && typeof psets[inst.def_name] === "object")
              ? (psets[inst.def_name] as Record<string, unknown>)
              : {};
            for (const [k, v] of Object.entries(inst.props)) {
              if (v !== null && v !== undefined && v !== "") target[k] = String(v);
            }
            psets[inst.def_name] = target;
            merged++;
          }
          e.psets = psets;
        }
        logger.debug(`[trimble] merged ${merged} Trimble pset instance(s) into ${entities.length} entities`);
      }
    } catch (e) {
      logger.warn(`[trimble] could not merge PSet-service properties: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    include_production_counts?: boolean;
    default_count?: number;
  }>();

  if (!body.project_uuid) return c.json({ error: "Missing project_uuid" }, 400);
  if (!body.entities?.length) return c.json({ error: "Missing entities" }, 400);

  const defaultCount = normalizeCount(body.default_count);
  const includeCounts = Boolean(body.include_production_counts);

  const designsMap = await loadDesigns(body.project_uuid, { fuzzy: true });
  const batches = await loadBatches(body.project_uuid);
  const dbBatches = new Map(db.getBatches(body.project_uuid).map((b) => [b.uuid, b]));
  const existingCounts = await getProductionCounts(body.project_uuid);
  const projectPhases = await loadProjectPhases(body.project_uuid);
  const existingPhases = new Set(projectPhases.map((p) => p.trim().toLowerCase()));

  const designProp = resolveProp(body.column_mapping, "design_name");
  const batchProp = resolveProp(body.column_mapping, "batch_number");
  const orderProp = resolveProp(body.column_mapping, "client_order_id");
  const countProp = resolveProp(body.column_mapping, "count");
  const phaseProp = resolveProp(body.column_mapping, "phase");

  let entities = body.entities;
  if (body.unique_only) {
    const seen = new Set<string>();
    entities = entities.filter((e) => {
      const design = designProp ? extractProp(e, designProp) : "";
      const batch = batchProp ? extractProp(e, batchProp) : "";
      // client_order_id distinguishes distinct production constructs — don't
      // collapse them into a single design count.
      const order = orderProp ? extractProp(e, orderProp) : "";
      const key = `${design}|${batch}|${order}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  logger.debug(`[trimble preview] project=${body.project_uuid}, entities=${entities.length}, designs=${designsMap.size}`);

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
  logger.debug(`[trimble preview] loaded ${allAssemblies.length} assemblies across ${asmByBatch.size} batches`);

  const byBatch = new Map<string, Record<string, unknown>[]>();
  const matchBatch = buildBatchMatcher(batches);
  const unresolvedBatches = new Set<string>();
  const unresolvedDesigns = new Set<string>();
  const unresolvedPhases = new Set<string>();

  // Detect missing phases across ALL entities (independent of batch matching),
  // so the user can create them before importing.
  if (phaseProp) {
    for (const entity of entities) {
      const entityPhase = (extractProp(entity, phaseProp) || "").trim();
      if (entityPhase && !existingPhases.has(entityPhase.toLowerCase())) unresolvedPhases.add(entityPhase);
    }
  }

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
      const entityPhase = phaseProp ? (extractProp(entity, phaseProp) || "").trim() : "";
      const matched = batchRaw ? matchBatch(batchRaw, entityPhase) : null;
      if (!matched) { if (batchRaw) unresolvedBatches.add(batchRaw); continue; }
      const uuid = matched.uuid as string;
      if (!byBatch.has(uuid)) byBatch.set(uuid, []);
      byBatch.get(uuid)!.push(entity);
    }
  }

  const batchPreviews = [];
  let bi = 0;
  const batchById = new Map<string, Record<string, unknown>>();
  for (const b of batches) batchById.set(b.uuid as string, b);

  for (const [batchUuid, ents] of byBatch) {
    bi++;
    const dbState = dbBatches.get(batchUuid)?.state ?? "provisional";
    const batchInfo = batchById.get(batchUuid) ?? {};
    const batchName = (batchInfo.name as string) ?? batchUuid;
    const batchPhase = String(batchInfo.phase ?? "").trim();

    const countMap = new Map<string, { design: string; design_name: string; phase: string; count: number }>();
    for (const entity of ents) {
      const dn = designProp ? extractProp(entity, designProp) : "";
      const designUuid = fuzzyDesignLookup(designsMap, dn) ?? null;
      if (dn && !designUuid) { unresolvedDesigns.add(dn); continue; }
      if (!designUuid) continue;
      const entityPhase = phaseProp ? (extractProp(entity, phaseProp) || "").trim() : "";
      const phase = entityPhase || batchPhase;
      const count = countProp ? parseCount(extractProp(entity, countProp), defaultCount) : defaultCount;
      const key = `${phase}|${designUuid}`;
      const entry = countMap.get(key);
      if (entry) entry.count += count;
      else countMap.set(key, { design: designUuid, design_name: dn || designUuid, phase, count });
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

    const summary = {
      total: rowPreviews.reduce((a, r) => a + (r.count_requested || 0), 0),
      new: rowPreviews.filter((r) => r.status === "new").reduce((a, r) => a + (r.count_to_create || 0), 0),
      changed: rowPreviews.filter((r) => r.status === "changed").reduce((a, r) => a + (r.count_to_create || 0), 0),
      identical: rowPreviews.filter((r) => r.status === "identical").length,
      blocked: rowPreviews.filter((r) => r.status === "blocked").length,
    };
    logger.debug(`[trimble preview] batch ${bi}/${byBatch.size} "${batchName}": ${summary.new} new, ${summary.changed} changed, ${summary.identical} identical, ${summary.blocked} blocked`);

    batchPreviews.push({ batch_uuid: batchUuid, batch_name: batchName, local_state: dbState, blocked: dbState === "definitive", rows: rowPreviews, summary });
  }

  logger.debug(`[trimble preview] DONE — ${byBatch.size} batches checked, ${unresolvedDesigns.size} unmatched designs, ${unresolvedBatches.size} unmatched batches`);

  return c.json({
    batch_previews: batchPreviews,
    unresolved_batches: [...unresolvedBatches].sort(),
    unresolved_designs: [...unresolvedDesigns].sort(),
    unresolved_phases: [...unresolvedPhases].sort(),
    production_counts_included: includeCounts,
    default_count: defaultCount,
    preview_token: issuePreviewToken(GATE.trimbleImport, trimbleGateInput(body)),
  });
});

// Execute import after user reviewed preview
app.post("/import", async (c) => {
  const body = await c.req.json<{
    project_uuid: string;
    column_mapping: ColumnMapping;
    entities: Record<string, unknown>[];
    unique_only?: boolean;
    preview_token?: string;
    include_production_counts?: boolean;
    default_count?: number;
  }>();

  if (!body.project_uuid) return c.json({ error: "Missing project_uuid" }, 400);
  if (!body.entities?.length) return c.json({ error: "Missing entities" }, 400);

  // Nothing reaches Produuzit without a matching, unexpired, unused check.
  const blocked = requirePreviewToken(c, GATE.trimbleImport, body.preview_token, trimbleGateInput(body));
  if (blocked) return blocked;

  const defaultCount = normalizeCount(body.default_count);
  const includeCounts = Boolean(body.include_production_counts);

  // Snapshot the project's counts before doing any work; the write below is
  // conditional on them being unchanged.
  const countsSignature = includeCounts ? await getProductionCountsSignature(body.project_uuid) : null;

  const designsMap = await loadDesigns(body.project_uuid, { fuzzy: true });
  const batches = await loadBatches(body.project_uuid);
  const dbBatches = new Map(db.getBatches(body.project_uuid).map((b) => [b.uuid, b]));

  const designProp = resolveProp(body.column_mapping, "design_name");
  const batchProp = resolveProp(body.column_mapping, "batch_number");
  const orderProp = resolveProp(body.column_mapping, "client_order_id");
  const countProp = resolveProp(body.column_mapping, "count");
  const phaseProp = resolveProp(body.column_mapping, "phase");

  let entities = body.entities;
  if (body.unique_only) {
    const seen = new Set<string>();
    entities = entities.filter((e) => {
      const design = designProp ? extractProp(e, designProp) : "";
      const batch = batchProp ? extractProp(e, batchProp) : "";
      // client_order_id distinguishes distinct production constructs — don't
      // collapse them into a single design count.
      const order = orderProp ? extractProp(e, orderProp) : "";
      const key = `${design}|${batch}|${order}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const results: Record<string, unknown>[] = [];
  const batchById = new Map<string, Record<string, unknown>>();
  for (const b of batches) batchById.set(b.uuid as string, b);
  const countMap = new Map<string, { batch: string; phase: string; design: string; design_name: string; count: number }>();

  const byBatch = new Map<string, Record<string, unknown>[]>();
  const matchBatch = buildBatchMatcher(batches);

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
      const entityPhase = phaseProp ? (extractProp(entity, phaseProp) || "").trim() : "";
      const matched = batchRaw ? matchBatch(batchRaw, entityPhase) : null;
      if (matched) {
        const uuid = matched.uuid as string;
        if (!byBatch.has(uuid)) byBatch.set(uuid, []);
        byBatch.get(uuid)!.push(entity);
      } else if (batchRaw) {
        // Graceful error — record unmatched batch value for notification
        const phaseSuffix = entityPhase ? ` (phase "${entityPhase}")` : "";
        results.push({ design_name: designProp ? extractProp(entity, designProp) : "", batch: batchRaw, phase: entityPhase || undefined, status: "error", reason: `No batch named "${batchRaw}"${phaseSuffix} found in project` });
      }
    }
  }

  for (const [batchUuid, ents] of byBatch) {
    const dbState = dbBatches.get(batchUuid)?.state ?? "provisional";
    const batchInfo = batchById.get(batchUuid) ?? {};
    const batchName = (batchInfo.name as string) ?? batchUuid;
    const batchPhase = String(batchInfo.phase ?? "").trim();

    if (dbState === "definitive") {
      for (const e of ents) {
        results.push({ design_name: designProp ? extractProp(e, designProp) : "", batch: batchName, status: "blocked", reason: "Batch is definitive" });
      }
      continue;
    }

    for (const entity of ents) {
      const dn = designProp ? extractProp(entity, designProp) : "";
      const designUuid = fuzzyDesignLookup(designsMap, dn);
      if (!designUuid) {
        results.push({ design_name: dn, batch: batchName, status: "error", reason: `Design '${dn}' not found` });
        continue;
      }
      const entityPhase = phaseProp ? (extractProp(entity, phaseProp) || "").trim() : "";
      const phase = entityPhase || batchPhase;
      const count = countProp ? parseCount(extractProp(entity, countProp), defaultCount) : defaultCount;
      const key = `${batchUuid}|${phase}|${designUuid}`;
      const entry = countMap.get(key);
      if (entry) entry.count += count;
      else countMap.set(key, { batch: batchUuid, phase, design: designUuid, design_name: dn || designUuid, count });
    }
  }

  if (!includeCounts) {
    results.push({ status: "skipped", reason: "Production counts not requested" });
  } else if (countMap.size) {
    try {
      await upsertProductionCounts(body.project_uuid, [...countMap.values()], countsSignature ?? undefined);
      for (const e of countMap.values()) {
        const bn = (batchById.get(e.batch)?.name as string) ?? e.batch;
        results.push({ design_name: e.design_name, batch: bn, phase: e.phase, design: e.design, status: "created", count: e.count });
      }
    } catch (e) {
      if (e instanceof ConcurrentModificationError) {
        return c.json({ error: e.message, code: "CONCURRENT_MODIFICATION" }, 409);
      }
      results.push({ status: "error", reason: `Failed to write production counts: ${String(e)}` });
    }
  }

  const summary = {
    designs_created: results.filter((r) => r.status === "created").length,
    constructibles_created: results.filter((r) => r.status === "created").reduce((a, r) => a + (Number(r.count) || 0), 0),
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    error: results.filter((r) => r.status === "error").length,
  };
  return c.json({ results, summary, production_counts: { included: includeCounts, default_count: defaultCount } });
});

// Create missing designs explicitly — separate from the import confirmation.
// This lets the user review exactly which designs will be added and confirm
// them before any production counts are pushed.
app.post("/create-missing-designs", async (c) => {
  const body = await c.req.json<{ project_uuid: string; design_names: string[] }>();

  if (!body.project_uuid) return c.json({ error: "Missing project_uuid" }, 400);
  if (!body.design_names?.length) return c.json({ results: [], summary: { created: 0, failed: 0 } });

  const designsMap = await loadDesigns(body.project_uuid, { fuzzy: true });
  const results: Record<string, unknown>[] = [];
  const created = new Set<string>();

  for (const rawName of body.design_names) {
    const name = String(rawName ?? "").trim();
    if (!name) continue;
    // Skip designs that already exist (including 4th-char fuzzy variants) or
    // were created earlier in this same request.
    if (fuzzyDesignLookup(designsMap, name) || created.has(name)) continue;

    try {
      const res = (await apiPost("/constructibles/assembly_designs/", { name, project: body.project_uuid })) as Record<string, unknown>;
      const uuid = res.uuid as string;
      if (uuid) {
        created.add(name);
        results.push({ design_name: name, status: "created", uuid });
      } else {
        results.push({ design_name: name, status: "error", reason: "Produuzit returned no uuid for the new design" });
      }
    } catch (e) {
      // Surface the Produuzit error so the user is notified when additional
      // information is required before the design can be created.
      results.push({ design_name: name, status: "error", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({
    results,
    summary: {
      created: results.filter((r) => r.status === "created").length,
      failed: results.filter((r) => r.status === "error").length,
    },
  });
});

// Create missing phases explicitly — separate from the import confirmation,
// mirroring the missing-designs flow. Phases live on the project (project.phases).
app.post("/create-missing-phases", async (c) => {
  const body = await c.req.json<{ project_uuid: string; phases: string[] }>();

  if (!body.project_uuid) return c.json({ error: "Missing project_uuid" }, 400);
  if (!body.phases?.length) return c.json({ results: [], summary: { created: 0, failed: 0 } });

  const project = (await apiGet(`/company/projects/${body.project_uuid}/`)) as Record<string, unknown>;
  const existingPhases = phasesOf(project);
  const existingNorm = new Set(existingPhases.map((p) => p.trim().toLowerCase()));

  const results: Record<string, unknown>[] = [];
  const toAdd: string[] = [];
  const seen = new Set<string>();

  for (const rawPhase of body.phases) {
    const phase = String(rawPhase ?? "").trim();
    if (!phase || seen.has(phase)) continue;
    seen.add(phase);
    if (existingNorm.has(phase.toLowerCase())) {
      results.push({ phase, status: "already_exists" });
      continue;
    }
    toAdd.push(phase);
  }

  if (toAdd.length) {
    try {
      await apiPatch(`/company/projects/${body.project_uuid}/`, { phases: [...existingPhases, ...toAdd] });
      for (const p of toAdd) results.push({ phase: p, status: "created" });
    } catch (e) {
      for (const p of toAdd) results.push({ phase: p, status: "error", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({
    results,
    summary: {
      created: results.filter((r) => r.status === "created").length,
      already_exists: results.filter((r) => r.status === "already_exists").length,
      failed: results.filter((r) => r.status === "error").length,
    },
  });
});

// --- Helpers ---

// The exact inputs that determine what an import writes. Preview and import must
// build this identically or the fingerprints will not match.
export function trimbleGateInput(body: {
  project_uuid: string;
  column_mapping: ColumnMapping;
  entities: Record<string, unknown>[];
  unique_only?: boolean;
  include_production_counts?: boolean;
  default_count?: number;
}) {
  return {
    project_uuid: body.project_uuid,
    column_mapping: body.column_mapping,
    entities: body.entities,
    unique_only: Boolean(body.unique_only),
    include_production_counts: Boolean(body.include_production_counts),
    default_count: normalizeCount(body.default_count),
  };
}

export function extractProp(entity: Record<string, unknown>, propPath: string): string {
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

// Load the project's phase list (project.phases) — phases are project-scoped.
function phasesOf(project: Record<string, unknown>): string[] {
  return (Array.isArray(project.phases) ? project.phases : []).map((p) => String(p));
}

async function loadProjectPhases(projectUuid: string): Promise<string[]> {
  const project = (await apiGet(`/company/projects/${projectUuid}/`)) as Record<string, unknown>;
  return phasesOf(project);
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
  visited: Set<string> = new Set(),
): Promise<Record<string, unknown>[]> {
  if (depth > 20) return [];
  // A depth cap alone does not stop a cycle in the folder graph fanning out.
  if (visited.has(folderId)) return [];
  visited.add(folderId);
  const items: Record<string, unknown>[] = [];
  let contents: unknown;
  try {
    contents = await trimbleGet(endpoints.Core + `folders/${folderId}/items`);
  } catch {
    return [];
  }

  const itemList = toItemList(contents);

  for (const item of itemList) {
    const itemType = String(item.type ?? "").toLowerCase();
    const name = (item.name as string) ?? "";
    const currentPath = parentPath ? `${parentPath}/${name}` : name;

    if (itemType === "folder") {
      const subId = (item.id as string) ?? "";
      if (subId && subId !== folderId) {
        items.push(...(await walkFolders(endpoints, subId, currentPath, depth + 1, visited)));
      }
    } else if (itemType === "file" && isIfcFile(name)) {
      item._parent = parentPath;
      items.push(item);
    }
  }
  return items;
}

export default app;
