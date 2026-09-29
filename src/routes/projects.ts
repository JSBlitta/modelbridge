import { Hono } from "hono";
import { apiGet, apiPost, apiPatch, fetchAllPages } from "../produuzit-client.ts";
import { getConfig } from "../config.ts";
import { boundedInt, isUuid } from "../lib/validate.ts";

const app = new Hono();

interface ProjectDef {
  project_key: string;
  superproject: string;
  letter: string;
  description?: string | null;
  suggested_suffix: string;
  phase: string;
  client_name?: string | null;
  batch_numbers?: string[];
}

function buildFullName(p: ProjectDef): string {
  const parts = [p.superproject, p.letter];
  if (p.description) parts.push(p.description);
  return parts.join("-");
}

app.get("/", async (c) => {
  const name = c.req.query("name");
  const projectNumber = c.req.query("project_number");
  const params: Record<string, string | number> = {
    limit: boundedInt(c.req.query("limit"), 50, 1, 1000),
    offset: boundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
  };
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
  if (!isUuid(uuid)) return c.json({ error: "Invalid project uuid" }, 400);
  return c.json(await apiGet(`/company/projects/${uuid}/`));
});

app.get("/:uuid/stdlibs", async (c) => {
  const uuid = c.req.param("uuid");
  if (!isUuid(uuid)) return c.json({ error: "Invalid project uuid" }, 400);
  const project = (await apiGet(`/company/projects/${uuid}/`)) as Record<string, unknown>;
  const linkedUuids = (project.linked_stdlibs ?? []) as string[];

  const stdlibs = await Promise.all(linkedUuids.map(async (sid) => {
    try {
      const slib = (await apiGet(`/company/projects/${sid}/`)) as Record<string, unknown>;
      return { uuid: sid, name: slib.name ?? sid, project_number: slib.project_number ?? "" };
    } catch {
      return { uuid: sid, name: sid, project_number: "" };
    }
  }));
  return c.json({ stdlibs });
});

app.post("/:uuid/phases", async (c) => {
  const uuid = c.req.param("uuid");
  if (!isUuid(uuid)) return c.json({ error: "Invalid project uuid" }, 400);
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

// Preview: check which projects exist, which are new — also checks superproject, phase, and batches
app.post("/find-or-create", async (c) => {
  const projects = await c.req.json<ProjectDef[]>();
  const all = (await fetchAllPages("/company/projects/")) as Record<string, unknown>[];
  const byName = new Map<string, Record<string, unknown>>();
  for (const p of all) byName.set(p.name as string, p);

  // Determine which superproject numbers are already present in Produuzit
  const knownSuperprojects = new Set<string>();
  for (const proj of all) {
    if (proj.super_project) knownSuperprojects.add(String(proj.super_project));
    const m = /^(\d+)-/.exec((proj.name as string) ?? "");
    if (m) knownSuperprojects.add(m[1]);
  }

  const results = await Promise.all(projects.map(async (p) => {
    const fullName = buildFullName(p);
    const lookupName = p.letter ? fullName : p.project_key;
    const existing = byName.get(lookupName) ?? byName.get(fullName);
    const superprojectFound = p.superproject ? knownSuperprojects.has(p.superproject) : null;

    if (!existing) {
      return {
        project_key: p.project_key,
        status: "new",
        existing: null,
        superproject_found: superprojectFound,
        phase_exists: null as boolean | null,
        batches_found: [] as string[],
        batches_missing: (p.batch_numbers ?? []) as string[],
      };
    }

    const existingPhases = (existing.phases ?? []) as string[];
    const phaseExists = p.phase
      ? existingPhases.some((ep) => String(ep).trim().toLowerCase() === p.phase.trim().toLowerCase())
      : null;

    let batchesFound: string[] = [];
    let batchesMissing: string[] = [];

    // Batches are always children of a phase — if the phase doesn't exist,
    // the batches can't exist yet either, regardless of name matches.
    const uuid = existing.uuid as string | undefined;
    const specs = (p as any).batch_specs as { number: string | number; phase: string }[] | undefined;
    if (uuid && specs?.length && phaseExists !== false) {
      try {
        // Enumerate every page: a hard limit here reported existing batches as
        // missing past the cap, which caused duplicate creation.
        const allBatches = (await fetchAllPages("/constructibles/batches/", { project: uuid })) as Record<string, unknown>[];
        for (const spec of specs) {
          const phaseNorm = (spec.phase || p.phase).trim().toLowerCase();
          const exists = allBatches.some(
            (b) => String(b.name ?? "").trim() === String(spec.number) && String(b.phase ?? "").trim().toLowerCase() === phaseNorm
          );
          if (exists) batchesFound.push(String(spec.number));
          else batchesMissing.push(String(spec.number));
        }
      } catch {
        // Batch check failed — treat all as missing (will be created or skipped if they already exist)
      }
    }

    return {
      project_key: p.project_key,
      status: "found",
      existing,
      superproject_found: superprojectFound,
      phase_exists: phaseExists,
      batches_found: batchesFound,
      batches_missing: batchesMissing,
    };
  }));

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
    const lookupName = p.letter ? fullName : p.project_key;
    const createName = lookupName;
    if (byName.has(lookupName)) {
      results.push({ project_key: p.project_key, status: "already_exists", data: byName.get(lookupName) });
      continue;
    }

    const projectNumber = [p.superproject, p.letter, p.description].filter(Boolean).join("-");
    const body = {
      name: createName,
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
