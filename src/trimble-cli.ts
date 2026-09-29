import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { env } from "./env.ts";
import {
  beginOAuth,
  redeemOAuthState,
  exchangeCode,
  fetchAllTrimblePages,
  fetchEntityPsets,
  getCallbackUrls,
  getRegionEndpoints,
  isAuthenticated,
  trimbleGet,
} from "./trimble-client.ts";
import { initDb } from "./db.ts";

interface ModelChoice {
  modelId: string;
  fileId: string;
  name: string;
  versionId: string;
  path: string;
}

interface PsetDef {
  idx: number;
  name: string;
  props: { name: string; type?: string }[];
}

async function main(): Promise<void> {
  initDb();

  if (!isAuthenticated()) {
    await authenticate();
  } else {
    console.log("Already authenticated.\n");
  }

  const endpoints = getRegionEndpoints();
  const projectId = await selectProject(endpoints);
  const model = await selectModel(endpoints, projectId);

  console.log("\nFetching model data...");
  console.log("  projectId:", projectId);
  console.log("  modelId:", model.modelId);
  console.log("  versionId:", model.versionId);

  const entities = await fetchEntities(endpoints, model);
  const psetdefs = await fetchPsetDefs(endpoints, model);
  const withIfcPsets = mergeIfcPsets(entities, psetdefs);
  const withAllPsets = await mergeTrimblePsets(withIfcPsets, projectId);

  console.log(`\nResult: ${withAllPsets.length} entities`);
  const withPsets = withAllPsets.filter((e) => e.psets && Object.keys(e.psets as object).length > 0);
  console.log(`Entities with psets: ${withPsets.length}`);

  if (withAllPsets.length > 0) {
    console.log("\nFirst entity sample:");
    console.log(JSON.stringify(withAllPsets[0], null, 2));
  }
}

async function authenticate(): Promise<void> {
  const callbackUrl = getCallbackUrls()[0];
  if (!callbackUrl) {
    throw new Error("No Trimble callback URL configured (TRIMBLE_CALLBACK_URLS)");
  }

  const { url, state } = beginOAuth(callbackUrl);
  const redirect = new URL(callbackUrl);
  const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
  const pathname = redirect.pathname || "/";

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (reqUrl.pathname !== pathname) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = reqUrl.searchParams.get("code");
        const callbackState = reqUrl.searchParams.get("state");
        if (!code || callbackState !== state) {
          throw new Error("OAuth callback missing code or state mismatch");
        }

        const flow = redeemOAuthState(callbackState ?? undefined);
        if (!flow) {
          throw new Error("Invalid or expired OAuth state");
        }

        await exchangeCode(code, flow.redirectUri);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authentication successful</h1><p>You can close this window.</p></body></html>");
        server.close();
        resolve();
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(error instanceof Error ? error.message : "Authentication failed");
        server.close();
        reject(error);
      }
    });

    server.listen(port, "localhost", () => {
      console.log(`Listening for OAuth callback on ${callbackUrl}`);
      console.log("Opening browser for login...\n");
      console.log("If the browser does not open, visit this URL manually:");
      console.log(url, "\n");
      openBrowser(url);
    });

    server.on("error", reject);
  });

  console.log("Authenticated successfully.\n");
}

async function selectProject(endpoints: Record<string, string>): Promise<string> {
  console.log("Fetching projects...");
  const raw = await trimbleGet(endpoints.Core + "projects", { fullyLoaded: "false", sort: "-name" });
  const projects = toItemList(raw)
    .map((p) => ({ id: String(p.id ?? p.projectId ?? ""), name: String(p.name ?? "") }))
    .filter((p) => p.id);

  if (projects.length === 0) {
    throw new Error("No projects found");
  }

  console.log("\nProjects:");
  projects.forEach((project, index) => {
    console.log(`  [${index + 1}] ${project.name} (${project.id})`);
  });

  const input = await ask(`\nSelect a project (1-${projects.length}): `);
  const index = Number(input) - 1;
  if (Number.isNaN(index) || index < 0 || index >= projects.length) {
    throw new Error("Invalid project selection");
  }

  const selected = projects[index];
  console.log(`Selected: ${selected.name}`);
  return selected.id;
}

async function selectModel(endpoints: Record<string, string>, projectId: string): Promise<ModelChoice> {
  console.log("\nWalking folders for model files...");
  const rootId = await getProjectRootId(endpoints, projectId);
  if (!rootId) {
    throw new Error("Project has no root folder");
  }

  const items = await walkFolders(endpoints, rootId, "");
  const models: ModelChoice[] = [];

  for (const item of items) {
    const name = String(item.name ?? "");
    if (!isIfcFile(name)) continue;
    const versions = await fetchFileVersions(endpoints, String(item.id ?? ""));
    const latest = pickLatestVersion(versions);
    if (!latest) continue;
    models.push({
      modelId: String(latest.id ?? ""),
      fileId: String(item.id ?? ""),
      name,
      versionId: String(latest.versionId ?? ""),
      path: String(item._parent ?? ""),
    });
  }

  if (models.length === 0) {
    throw new Error("No model files found in project");
  }

  console.log("\nModel files:");
  models.forEach((model, index) => {
    console.log(`  [${index + 1}] ${model.path}/${model.name} (modelId=${model.modelId}, version=${model.versionId})`);
  });

  const input = await ask(`\nSelect a model (1-${models.length}): `);
  const index = Number(input) - 1;
  if (Number.isNaN(index) || index < 0 || index >= models.length) {
    throw new Error("Invalid model selection");
  }

  const selected = models[index];
  console.log(`Selected: ${selected.name}`);
  return selected;
}

async function fetchEntities(endpoints: Record<string, string>, model: ModelChoice): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {
    versionId: model.versionId,
    fields: "idc,psets,psets.name,type",
  };
  return (await fetchAllTrimblePages(endpoints.Model + `models/${model.modelId}/entities`, 1000, params)) as Record<string, unknown>[];
}

async function fetchPsetDefs(endpoints: Record<string, string>, model: ModelChoice): Promise<PsetDef[]> {
  const params: Record<string, string> = { versionId: model.versionId };
  const items = (await fetchAllTrimblePages(endpoints.Model + `models/${model.modelId}/psetdefs`, 30000, params)) as Record<string, unknown>[];
  return items.map((item) => ({
    idx: Number(item.idx ?? 0),
    name: String(item.name ?? ""),
    props: (item.props ?? item.properties ?? []) as { name: string; type?: string }[],
  }));
}

function mergeIfcPsets(entities: Record<string, unknown>[], psetdefs: PsetDef[]): Record<string, unknown>[] {
  const defMap = new Map<number, { name: string; propNames: string[] }>();
  for (const def of psetdefs) {
    defMap.set(def.idx, { name: def.name, propNames: def.props.map((p) => p.name) });
  }

  return entities.map((entity) => {
    const rawPsets = entity.psets as Array<{ idx: number; name?: string; values?: unknown[] }> | undefined;
    if (!rawPsets || !Array.isArray(rawPsets)) return entity;

    const psetObj: Record<string, Record<string, unknown>> = {};
    for (const pset of rawPsets) {
      const def = defMap.get(pset.idx);
      const psetName = pset.name ?? def?.name ?? `pset_${pset.idx}`;
      const propNames = def?.propNames ?? [];
      const values = pset.values ?? [];
      const propObj: Record<string, unknown> = {};
      for (let i = 0; i < values.length; i++) {
        if (values[i] !== null && values[i] !== undefined && values[i] !== "") {
          propObj[propNames[i] ?? String(i)] = values[i];
        }
      }
      psetObj[psetName] = propObj;
    }
    return { ...entity, psets: psetObj };
  });
}

async function mergeTrimblePsets(entities: Record<string, unknown>[], projectId: string): Promise<Record<string, unknown>[]> {
  const entityGuids = entities
    .map((e) => [e.id, e.idc, e.entityId].filter((v) => v != null).map(String)[0])
    .filter((guid): guid is string => Boolean(guid));

  if (entityGuids.length === 0) {
    return entities;
  }

  console.log(`Fetching Trimble psets for ${entityGuids.length} entities...`);
  const instances = await fetchEntityPsets(entityGuids, { projectId });
  if (instances.length === 0) {
    console.log("No Trimble psets found.");
    return entities;
  }

  const byEntity = new Map<string, typeof instances>();
  for (const inst of instances) {
    const list = byEntity.get(inst.entity_id);
    if (list) list.push(inst);
    else byEntity.set(inst.entity_id, [inst]);
  }

  let merged = 0;
  for (const e of entities) {
    const candidates = [e.id, e.idc, e.entityId].filter((v) => v != null).map((v) => String(v));
    let list: typeof instances | undefined;
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
        if (v !== null && v !== undefined && v !== "") target[k] = v;
      }
      psets[inst.def_name] = target;
      merged++;
    }
    e.psets = psets;
  }

  console.log(`Merged ${merged} Trimble pset instance(s).`);
  return entities;
}

function toItemList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const p = raw as Record<string, unknown>;
    return (p.results ?? p.items ?? []) as Record<string, unknown>[];
  }
  return [];
}

function isIfcFile(filename: string): boolean {
  const n = filename.toLowerCase();
  return n.endsWith(".ifc") || n.endsWith(".ifczip") || n.endsWith(".ifcxml") || n.endsWith(".trb");
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
  if (depth > 20 || visited.has(folderId)) return [];
  visited.add(folderId);

  let contents: unknown;
  try {
    contents = await trimbleGet(endpoints.Core + `folders/${folderId}/items`);
  } catch {
    return [];
  }

  const items: Record<string, unknown>[] = [];
  for (const item of toItemList(contents)) {
    const itemType = String(item.type ?? "").toLowerCase();
    const name = String(item.name ?? "");
    const currentPath = parentPath ? `${parentPath}/${name}` : name;

    if (itemType === "folder") {
      const subId = String(item.id ?? "");
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

async function fetchFileVersions(endpoints: Record<string, string>, fileId: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await trimbleGet(endpoints.Core + `files/${fileId}/versions`);
    return toItemList(raw);
  } catch {
    return [];
  }
}

function pickLatestVersion(versions: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (versions.length === 0) return undefined;
  return [...versions].sort((a, b) => {
    const aDate = new Date(String(a.modifiedOn ?? a.createdOn ?? 0)).getTime();
    const bDate = new Date(String(b.modifiedOn ?? b.createdOn ?? 0)).getTime();
    return bDate - aDate;
  })[0];
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const command = platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
