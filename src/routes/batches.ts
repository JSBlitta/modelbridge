import { Hono } from "hono";
import { apiGet, apiPatch, apiPost, fetchAllPages } from "../produuzit-client.ts";
import { boundedInt, isUuid } from "../lib/validate.ts";
import { GATE, issuePreviewToken, requirePreviewToken } from "../lib/push-gate.ts";
import { compareBatches } from "../lib/idempotency.ts";
import * as db from "../db.ts";
import { logger } from "../logger.ts";

const app = new Hono();

interface BatchDef {
  name: string;
  phase: string;
  linked_stdlibs?: string[] | null;
  linked_stdlib_names?: string[] | null;
}

app.get("/", async (c) => {
  const projectUuid = c.req.query("project_uuid");
  const params: Record<string, string | number> = {
    limit: boundedInt(c.req.query("limit"), 100, 1, 1000),
    offset: boundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
  };
  if (projectUuid) {
    if (!isUuid(projectUuid)) return c.json({ error: "Invalid project_uuid" }, 400);
    params.project = projectUuid;
  }
  return c.json(await apiGet("/constructibles/batches/", params));
});

app.get("/db", async (c) => {
  const projectUuid = c.req.query("project_uuid") ?? undefined;
  return c.json(db.getBatches(projectUuid));
});

// Preview: show diff between proposed and existing batches
app.post("/preview", async (c) => {
  const body = await c.req.json<{ project_uuid: string; batches: BatchDef[] }>();
  if (!isUuid(body.project_uuid)) return c.json({ error: "Invalid project_uuid" }, 400);
  // All pages: the old `limit: 200` reported existing batches as new past the
  // cap, so confirming the preview created duplicates.
  const existing = (await fetchAllPages("/constructibles/batches/", { project: body.project_uuid })) as Record<string, unknown>[];
  const proposed = body.batches.map((b) => ({ name: b.name, phase: b.phase }));
  const diff = compareBatches(existing, proposed, "name");
  return c.json({
    diff,
    preview_token: issuePreviewToken(GATE.batchCreate, batchGateInput(body)),
  });
});

function batchGateInput(body: { project_uuid: string; batches: BatchDef[] }) {
  return { project_uuid: body.project_uuid, batches: body.batches };
}

// Create only after user reviewed preview
app.post("/create", async (c) => {
  const body = await c.req.json<{ project_uuid: string; batches: BatchDef[]; preview_token?: string }>();
  if (!isUuid(body.project_uuid)) return c.json({ error: "Invalid project_uuid" }, 400);

  const blocked = requirePreviewToken(c, GATE.batchCreate, body.preview_token, batchGateInput(body));
  if (blocked) return blocked;

  const existingBatches = (await fetchAllPages("/constructibles/batches/", { project: body.project_uuid })) as Record<string, unknown>[];
  const existingNames = new Set(existingBatches.map((b) => b.name as string));

  // Resolve stdlib names -> UUIDs once for this request
  const allNames = new Set<string>();
  for (const b of body.batches) {
    if (b.linked_stdlib_names?.length) for (const n of b.linked_stdlib_names) allNames.add(n);
  }
  const stdlibNameToUuid = new Map<string, string>();
  if (allNames.size) {
    try {
      const stdlibProjects = (await fetchAllPages("/company/projects/", { standard_library: true })) as Record<string, unknown>[];
      for (const p of stdlibProjects) {
        const uuid = p.uuid as string;
        if (!uuid) continue;
        const name = (p.name as string ?? "").toLowerCase();
        const pnum = (p.project_number as string ?? "").toLowerCase();
        if (name) stdlibNameToUuid.set(name, uuid);
        if (pnum) stdlibNameToUuid.set(pnum, uuid);
      }
    } catch (e) {
      logger.warn("[batches/create] stdlib name resolution failed:", e);
    }
  }

  const results = [];
  for (const b of body.batches) {
    let resolvedStdlibs = b.linked_stdlibs ?? null;
    if ((!resolvedStdlibs?.length) && b.linked_stdlib_names?.length) {
      resolvedStdlibs = b.linked_stdlib_names
        .map((n) => {
          const uuid = stdlibNameToUuid.get(n.toLowerCase());
          if (!uuid) logger.warn(`[batches/create] stdlib not found: "${n}"`);
          return uuid;
        })
        .filter((u): u is string => !!u);
    }
    if (existingNames.has(b.name)) {
      const match = existingBatches.find((e) => e.name === b.name) as Record<string, unknown> | undefined;
      if (match) {
        db.upsertBatch(match.uuid as string, match.name as string, body.project_uuid, b.phase, resolvedStdlibs);
        // Patch stdlibs via API if they changed
        const existingMeta = (match.meta ?? {}) as Record<string, unknown>;
        const existingStdlibs = ((existingMeta.linked_stdlibs ?? []) as string[]).slice().sort();
        const newStdlibs = (resolvedStdlibs ?? []).slice().sort();
        if (newStdlibs.length && JSON.stringify(existingStdlibs) !== JSON.stringify(newStdlibs)) {
          try {
            await apiPatch(`/constructibles/batches/${match.uuid}/`, {
              meta: { ...existingMeta, linked_stdlibs: resolvedStdlibs },
            });
            results.push({ name: b.name, status: "updated_stdlibs", previous: existingStdlibs, updated: newStdlibs });
            continue;
          } catch (e) {
            logger.warn(`[batches/create] stdlib patch failed for "${b.name}":`, e);
          }
        }
        results.push({ name: b.name, status: "already_exists", data: match });
      }
      continue;
    }
    const apiBody: Record<string, unknown> = { name: b.name, project: body.project_uuid, phase: b.phase };
    if (resolvedStdlibs?.length) apiBody.meta = { linked_stdlibs: resolvedStdlibs };

    try {
      const created = (await apiPost("/constructibles/batches/", apiBody)) as Record<string, unknown>;
      db.upsertBatch(created.uuid as string, created.name as string, body.project_uuid, b.phase, resolvedStdlibs);
      results.push({ name: b.name, status: "created", data: created });
    } catch (e) {
      results.push({ name: b.name, status: "error", error: String(e) });
    }
  }
  return c.json(results);
});

// Update local state only (provisional/definitive)
app.patch("/state", async (c) => {
  const body = await c.req.json<{ batch_uuids: string[]; state: string }>();
  if (body.state !== "provisional" && body.state !== "definitive") {
    return c.json({ error: "State must be 'provisional' or 'definitive'" }, 400);
  }
  db.setBatchState(body.batch_uuids, body.state);
  return c.json({ updated: body.batch_uuids.length, state: body.state });
});

// Add phases & batches across multiple projects (used by unified import flow)
app.post("/add-for-projects", async (c) => {
  const body = await c.req.json<{
    phase: string;
    // project_uuid, when the caller knows it, wins over the name lookup: a project
    // named after a superproject column that differs from the key's number would
    // otherwise not resolve.
    batch_defs: { project_key: string; project_uuid?: string; batch_number: string | number; phase: string; stdlibs?: string[] }[];
    // Phases to ensure even when no batch in the file uses them.
    phase_defs?: { project_key: string; project_uuid?: string; phase: string }[];
  }>();
  const batchDefs = Array.isArray(body.batch_defs) ? body.batch_defs : [];
  const phaseDefs = Array.isArray(body.phase_defs) ? body.phase_defs : [];

  // Resolve project_key -> uuid by name
  const allProjects = (await fetchAllPages("/company/projects/")) as Record<string, unknown>[];
  const nameToUuid = new Map<string, string>();
  for (const p of allProjects) {
    const n = (p.name as string ?? "").trim();
    if (n) nameToUuid.set(n, p.uuid as string);
    // Also index by project_number
    const pnum = (p.project_number as string ?? "").trim();
    if (pnum) nameToUuid.set(pnum, p.uuid as string);
  }

  // Resolve stdlib names to UUIDs
  const allStdlibNames = new Set<string>();
  for (const b of batchDefs) {
    if (b.stdlibs?.length) for (const s of b.stdlibs) allStdlibNames.add(s);
  }
  const stdlibNameToUuid = new Map<string, string>();
  if (allStdlibNames.size) {
    try {
      const stdlibProjects = (await fetchAllPages("/company/projects/", { standard_library: true })) as Record<string, unknown>[];
      for (const p of stdlibProjects) {
        const uuid = p.uuid as string; if (!uuid) continue;
        const name = (p.name as string ?? "").toLowerCase();
        const pnum = (p.project_number as string ?? "").toLowerCase();
        if (name) stdlibNameToUuid.set(name, uuid);
        if (pnum) stdlibNameToUuid.set(pnum, uuid);
      }
    } catch (e) {
      logger.warn("[batches/add-for-projects] stdlib name resolution failed:", e);
    }
  }

  // Per-project caches. Without these the loop refetched the project and every
  // one of its batches once per batch_def — 50 defs on one project meant 100
  // redundant API calls.
  const projectCache = new Map<string, Record<string, unknown>>();
  const batchCache = new Map<string, Record<string, unknown>[]>();
  const phasesEnsured = new Set<string>();

  const results: Record<string, unknown>[] = [];
  const resolveUuid = (d: { project_key: string; project_uuid?: string }) =>
    (d.project_uuid && isUuid(d.project_uuid) ? d.project_uuid : undefined) ?? nameToUuid.get(String(d.project_key ?? "").trim());

  // Ensure a phase exists on a project, once per project+phase pair. Returns false on failure.
  async function ensurePhase(projectUuid: string, projectKey: string, phase: string): Promise<boolean> {
    const phaseKey = `${projectUuid}|${phase.toLowerCase()}`;
    if (phasesEnsured.has(phaseKey)) return true;
    phasesEnsured.add(phaseKey);
    try {
      let project = projectCache.get(projectUuid);
      if (!project) {
        project = (await apiGet(`/company/projects/${projectUuid}/`)) as Record<string, unknown>;
        projectCache.set(projectUuid, project);
      }
      const existingPhases = (project.phases ?? []) as string[];
      if (!existingPhases.some((ep) => String(ep).trim().toLowerCase() === phase.toLowerCase())) {
        const updatedPhases = [...existingPhases, phase];
        await apiPatch(`/company/projects/${projectUuid}/`, { phases: updatedPhases });
        project.phases = updatedPhases;
        results.push({ project_key: projectKey, phase, status: "phase_created" });
      }
      return true;
    } catch (e) {
      logger.warn(`[batches/add-for-projects] phase check failed for ${projectKey}:`, e);
      results.push({
        project_key: projectKey,
        phase,
        status: "error",
        error: `Could not ensure phase "${phase}": ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }

  for (const d of phaseDefs) {
    const phase = String(d.phase ?? "").trim();
    const projectUuid = resolveUuid(d);
    if (!phase) { results.push({ project_key: d.project_key, status: "error", error: "Phase is empty" }); continue; }
    if (!projectUuid) { results.push({ project_key: d.project_key, phase, status: "error", error: "Project not found: " + d.project_key }); continue; }
    await ensurePhase(projectUuid, d.project_key, phase);
  }

  for (const b of batchDefs) {
    const projectUuid = resolveUuid(b);
    if (!projectUuid) {
      results.push({ project_key: b.project_key, batch_number: b.batch_number, status: "error", error: "Project not found: " + b.project_key });
      continue;
    }
    // A batch always belongs to a phase; an empty one would create a phase named "".
    b.phase = String(b.phase ?? "").trim();
    if (!b.phase) {
      results.push({ project_key: b.project_key, batch_number: b.batch_number, status: "error", error: "Phase is empty" });
      continue;
    }
    if (!(await ensurePhase(projectUuid, b.project_key, b.phase))) {
      results.push({ project_key: b.project_key, batch_number: b.batch_number, status: "error", error: `Phase "${b.phase}" could not be ensured` });
      continue;
    }

    // Check if batch already exists for THIS phase (not just any phase)
    const batchName = String(b.batch_number);
    let projectBatches = batchCache.get(projectUuid);
    if (!projectBatches) {
      projectBatches = (await fetchAllPages("/constructibles/batches/", { project: projectUuid })) as Record<string, unknown>[];
      batchCache.set(projectUuid, projectBatches);
    }
    const existsForPhase = projectBatches.some(
      (x) => String(x.name ?? "").trim() === batchName && String(x.phase ?? "").trim().toLowerCase() === b.phase.trim().toLowerCase()
    );

    if (existsForPhase) {
      results.push({ project_key: b.project_key, batch_number: batchName, status: "already_exists" });
      continue;
    }

    // Resolve stdlibs
    let resolvedStdlibs: string[] | null = null;
    if (b.stdlibs?.length) {
      resolvedStdlibs = b.stdlibs
        .map((n) => stdlibNameToUuid.get(n.toLowerCase()))
        .filter((u): u is string => !!u);
    }

    // Create the batch
    const apiBody: Record<string, unknown> = { name: batchName, project: projectUuid, phase: b.phase };
    if (resolvedStdlibs?.length) apiBody.meta = { linked_stdlibs: resolvedStdlibs };

    try {
      const created = (await apiPost("/constructibles/batches/", apiBody)) as Record<string, unknown>;
      db.upsertBatch(created.uuid as string, created.name as string, projectUuid, b.phase, resolvedStdlibs);
      // Keep the cache honest so a later def for the same project sees it.
      projectBatches.push(created);
      results.push({ project_key: b.project_key, batch_number: batchName, status: "created", data: created });
    } catch (e) {
      results.push({ project_key: b.project_key, batch_number: batchName, status: "error", error: String(e) });
    }
  }
  return c.json(results);
});

export default app;
