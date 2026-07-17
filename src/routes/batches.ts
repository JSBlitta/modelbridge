import { Hono } from "hono";
import { apiGet, apiPatch, apiPost } from "../produuzit-client.js";
import { compareBatches } from "../lib/idempotency.js";
import * as db from "../db.js";

const app = new Hono();

interface BatchDef {
  name: string;
  phase: string;
  linked_stdlibs?: string[] | null;
  linked_stdlib_names?: string[] | null;
}

app.get("/", async (c) => {
  const projectUuid = c.req.query("project_uuid");
  const limit = c.req.query("limit") ?? "100";
  const offset = c.req.query("offset") ?? "0";
  const params: Record<string, string | number> = { limit: parseInt(limit), offset: parseInt(offset) };
  if (projectUuid) params.project = projectUuid;
  return c.json(await apiGet("/constructibles/batches/", params));
});

app.get("/db", async (c) => {
  const projectUuid = c.req.query("project_uuid") ?? undefined;
  return c.json(db.getBatches(projectUuid));
});

// Preview: show diff between proposed and existing batches
app.post("/preview", async (c) => {
  const body = await c.req.json<{ project_uuid: string; batches: BatchDef[] }>();
  const existingResp = (await apiGet("/constructibles/batches/", { project: body.project_uuid, limit: 200 })) as {
    results: Record<string, unknown>[];
  };
  const proposed = body.batches.map((b) => ({ name: b.name, phase: b.phase }));
  const diff = compareBatches(existingResp.results ?? [], proposed, "name");
  return c.json(diff);
});

// Create only after user reviewed preview
app.post("/create", async (c) => {
  const body = await c.req.json<{ project_uuid: string; batches: BatchDef[] }>();
  const existingResp = (await apiGet("/constructibles/batches/", { project: body.project_uuid, limit: 200 })) as {
    results: Record<string, unknown>[];
  };
  const existingNames = new Set((existingResp.results ?? []).map((b) => b.name as string));

  // Resolve stdlib names -> UUIDs once for this request
  const allNames = new Set<string>();
  for (const b of body.batches) {
    if (b.linked_stdlib_names?.length) for (const n of b.linked_stdlib_names) allNames.add(n);
  }
  const stdlibNameToUuid = new Map<string, string>();
  if (allNames.size) {
    try {
      const resp = (await apiGet("/company/projects/", { standard_library: true, limit: 200 })) as { results: Record<string, unknown>[] };
      for (const p of resp.results ?? []) {
        const uuid = p.uuid as string;
        if (!uuid) continue;
        const name = (p.name as string ?? "").toLowerCase();
        const pnum = (p.project_number as string ?? "").toLowerCase();
        if (name) stdlibNameToUuid.set(name, uuid);
        if (pnum) stdlibNameToUuid.set(pnum, uuid);
      }
    } catch (e) {
      console.warn("[batches] stdlib name resolution failed:", e);
    }
  }

  const results = [];
  for (const b of body.batches) {
    let resolvedStdlibs = b.linked_stdlibs ?? null;
    if ((!resolvedStdlibs?.length) && b.linked_stdlib_names?.length) {
      resolvedStdlibs = b.linked_stdlib_names
        .map((n) => {
          const uuid = stdlibNameToUuid.get(n.toLowerCase());
          if (!uuid) console.warn(`[batches] stdlib not found: "${n}"`);
          return uuid;
        })
        .filter((u): u is string => !!u);
    }
    if (existingNames.has(b.name)) {
      const match = (existingResp.results ?? []).find((e) => e.name === b.name) as Record<string, unknown> | undefined;
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
            console.warn(`[batches] stdlib patch failed for "${b.name}":`, e);
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
    batch_defs: { project_key: string; batch_number: string | number; phase: string; stdlibs?: string[] }[];
  }>();

  // Resolve project_key -> uuid by name
  const allProjects = (await apiGet("/company/projects/", { limit: 500 })) as { results: Record<string, unknown>[] };
  const nameToUuid = new Map<string, string>();
  for (const p of allProjects.results ?? []) {
    const n = (p.name as string ?? "").trim();
    if (n) nameToUuid.set(n, p.uuid as string);
    // Also index by project_number
    const pnum = (p.project_number as string ?? "").trim();
    if (pnum) nameToUuid.set(pnum, p.uuid as string);
  }

  // Resolve stdlib names to UUIDs
  const allStdlibNames = new Set<string>();
  for (const b of body.batch_defs) {
    if (b.stdlibs?.length) for (const s of b.stdlibs) allStdlibNames.add(s);
  }
  const stdlibNameToUuid = new Map<string, string>();
  if (allStdlibNames.size) {
    try {
      const resp = (await apiGet("/company/projects/", { standard_library: true, limit: 200 })) as { results: Record<string, unknown>[] };
      for (const p of resp.results ?? []) {
        const uuid = p.uuid as string; if (!uuid) continue;
        const name = (p.name as string ?? "").toLowerCase();
        const pnum = (p.project_number as string ?? "").toLowerCase();
        if (name) stdlibNameToUuid.set(name, uuid);
        if (pnum) stdlibNameToUuid.set(pnum, uuid);
      }
    } catch (e) {
      console.warn("[batches] stdlib name resolution failed:", e);
    }
  }

  const results: Record<string, unknown>[] = [];
  for (const b of body.batch_defs) {
    const projectUuid = nameToUuid.get(b.project_key);
    if (!projectUuid) {
      results.push({ project_key: b.project_key, batch_number: b.batch_number, status: "error", error: "Project not found: " + b.project_key });
      continue;
    }

    // Ensure phase exists on the project
    try {
      const project = (await apiGet(`/company/projects/${projectUuid}/`)) as Record<string, unknown>;
      const existingPhases = (project.phases ?? []) as string[];
      const phaseNormalized = b.phase.trim().toLowerCase();
      if (!existingPhases.some((ep) => String(ep).trim().toLowerCase() === phaseNormalized)) {
        const updatedPhases = [...existingPhases, b.phase];
        await apiPatch(`/company/projects/${projectUuid}/`, { phases: updatedPhases });
      }
    } catch (e) {
      console.warn(`[batches] phase check failed for ${b.project_key}:`, e);
    }

    // Check if batch already exists for THIS phase (not just any phase)
    const batchName = String(b.batch_number);
    const existingResp = (await apiGet("/constructibles/batches/", { project: projectUuid, limit: 200 })) as { results: Record<string, unknown>[] };
    console.log(`[add-for-projects] checking batch "${batchName}" phase="${b.phase}" against`, (existingResp.results ?? []).map(x => ({ name: x.name, phase: x.phase })));
    const existsForPhase = (existingResp.results ?? []).some(
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
      results.push({ project_key: b.project_key, batch_number: batchName, status: "created", data: created });
    } catch (e) {
      results.push({ project_key: b.project_key, batch_number: batchName, status: "error", error: String(e) });
    }
  }
  return c.json(results);
});

export default app;
