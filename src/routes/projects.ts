import { Hono } from "hono";
import { apiGet, apiPost, apiPatch, fetchAllPages } from "../produuzit-client.js";
import { getConfig } from "../config.js";

const app = new Hono();

interface ProjectDef {
  project_key: string;
  superproject: string;
  letter: string;
  description?: string | null;
  suggested_suffix: string;
  phase: string;
  client_name?: string | null;
}

function buildFullName(p: ProjectDef): string {
  const parts = [p.superproject, p.letter];
  if (p.description) parts.push(p.description);
  return parts.join("-");
}

app.get("/", async (c) => {
  const name = c.req.query("name");
  const projectNumber = c.req.query("project_number");
  const limit = c.req.query("limit") ?? "50";
  const offset = c.req.query("offset") ?? "0";
  const params: Record<string, string | number> = { limit: parseInt(limit), offset: parseInt(offset) };
  if (name) params.name = name;
  if (projectNumber) params.project_number = projectNumber;

  const raw = await apiGet("/company/projects/", params) as Record<string, unknown> | unknown[];
  // Produuzit may return paginated { count, results } or a bare array — normalise.
  const results = Array.isArray(raw) ? raw : ((raw.results ?? []) as unknown[]);
  const count   = Array.isArray(raw) ? raw.length : ((raw.count as number) ?? results.length);
  return c.json({ count, results });
});

app.get("/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  return c.json(await apiGet(`/company/projects/${uuid}/`));
});

app.get("/:uuid/stdlibs", async (c) => {
  const uuid = c.req.param("uuid");
  const project = (await apiGet(`/company/projects/${uuid}/`)) as Record<string, unknown>;
  const linkedUuids = (project.linked_stdlibs ?? []) as string[];

  const stdlibs = [];
  for (const sid of linkedUuids) {
    try {
      const slib = (await apiGet(`/company/projects/${sid}/`)) as Record<string, unknown>;
      stdlibs.push({ uuid: sid, name: slib.name ?? sid, project_number: slib.project_number ?? "" });
    } catch {
      stdlibs.push({ uuid: sid, name: sid, project_number: "" });
    }
  }
  return c.json({ stdlibs });
});

app.post("/:uuid/phases", async (c) => {
  const uuid = c.req.param("uuid");
  const body = await c.req.json<{ phase: string }>();
  const phase = (body.phase ?? "").trim();
  if (!phase) return c.json({ error: "Phase cannot be empty" }, 400);

  const project = (await apiGet(`/company/projects/${uuid}/`)) as Record<string, unknown>;
  const existingPhases = (project.phases ?? []) as string[];
  const normalized = new Set(existingPhases.filter((p): p is string => typeof p === "string").map((p) => p.trim().toLowerCase()));

  if (normalized.has(phase.toLowerCase())) {
    return c.json({ status: "already_exists", phase, phases: existingPhases });
  }

  const updatedPhases = [...existingPhases, phase];
  const updated = (await apiPatch(`/company/projects/${uuid}/`, { phases: updatedPhases })) as Record<string, unknown>;
  return c.json({ status: "added", phase, phases: updated.phases ?? updatedPhases });
});

// Preview: check which projects exist, which are new
app.post("/find-or-create", async (c) => {
  const projects = await c.req.json<ProjectDef[]>();
  const all = (await fetchAllPages("/company/projects/")) as Record<string, unknown>[];
  const byName = new Map<string, Record<string, unknown>>();
  for (const p of all) byName.set(p.name as string, p);

  const results = projects.map((p) => {
    const fullName = buildFullName(p);
    if (byName.has(fullName)) {
      return { project_key: p.project_key, status: "found", existing: byName.get(fullName) };
    }
    return { project_key: p.project_key, status: "new", existing: null };
  });
  return c.json(results);
});

// Create only after user has reviewed the preview
app.post("/create", async (c) => {
  const projects = await c.req.json<ProjectDef[]>();
  const cfg = getConfig();
  const clientNameDefault = cfg.defaults.client_name;

  const all = (await fetchAllPages("/company/projects/")) as Record<string, unknown>[];
  const byName = new Map<string, Record<string, unknown>>();
  for (const p of all) byName.set(p.name as string, p);

  const results = [];
  for (const p of projects) {
    const fullName = buildFullName(p);
    if (byName.has(fullName)) {
      results.push({ project_key: p.project_key, status: "already_exists", data: byName.get(fullName) });
      continue;
    }

    const projectNumber = [p.superproject, p.letter, p.description].filter(Boolean).join("-");
    const body = {
      name: fullName,
      super_project: p.superproject,
      client_name: p.client_name || clientNameDefault,
      project_number: projectNumber,
      phases: [p.phase],
      standard_library: false,
      linked_stdlibs: [],
    };

    try {
      const created = await apiPost("/company/projects/", body);
      results.push({ project_key: p.project_key, status: "created", data: created });
    } catch (e) {
      results.push({ project_key: p.project_key, status: "error", error: String(e) });
    }
  }
  return c.json(results);
});

export default app;
