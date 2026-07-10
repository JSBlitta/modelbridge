import { Hono } from "hono";
import { apiGet, apiPost } from "../produuzit-client.js";
import { compareBatches } from "../lib/idempotency.js";
import * as db from "../db.js";

const app = new Hono();

interface BatchDef {
  name: string;
  phase: string;
  linked_stdlibs?: string[] | null;
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

  const results = [];
  for (const b of body.batches) {
    if (existingNames.has(b.name)) {
      const match = (existingResp.results ?? []).find((e) => e.name === b.name) as Record<string, unknown> | undefined;
      if (match) db.upsertBatch(match.uuid as string, match.name as string, body.project_uuid, b.phase, b.linked_stdlibs);
      results.push({ name: b.name, status: "already_exists", data: match });
      continue;
    }
    const apiBody: Record<string, unknown> = { name: b.name, project: body.project_uuid, phase: b.phase };
    if (b.linked_stdlibs?.length) apiBody.meta = { linked_stdlibs: b.linked_stdlibs };

    try {
      const created = (await apiPost("/constructibles/batches/", apiBody)) as Record<string, unknown>;
      db.upsertBatch(created.uuid as string, created.name as string, body.project_uuid, b.phase, b.linked_stdlibs);
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

export default app;
