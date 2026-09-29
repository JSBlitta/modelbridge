import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./env.ts";
import { recordEvent, createPreviewToken, consumePreviewToken, getTrimbleRefreshToken, setTrimbleRefreshToken } from "./db.ts";
import { logger } from "./logger.ts";
import { parseFrn, safeDecode } from "./trimble-frn.ts";

/**
 * The translation block to read pset names from. Trimble's API spec uses "en"
 * in its example, its Postman collection uses "en-US", and a library authored
 * in another language may have neither — in which case any real locale beats
 * none. "__prop-order__" style keys are control blocks, not locales.
 */
export function pickLocale(
  i18n: Record<string, { name?: string; props?: Record<string, string> }> | undefined,
): { name?: string; props?: Record<string, string> } {
  if (!i18n) return {};
  for (const key of ["en-US", "en"]) if (i18n[key]) return i18n[key];
  const real = Object.keys(i18n).find((k) => !k.startsWith("__"));
  return real ? i18n[real] : {};
}

/**
 * Extract the library id from a PSetLibs link. Library resource ids are
 * compound (`frn:lib:{libId}:{projectId}:{uuid}`, percent-encoded per segment)
 * — keeping only the first colon-segment 404s on the PSet service.
 */
function libraryIdFromLink(link: string): string {
  const parsed = parseFrn(link);
  if (parsed.isFrn && parsed.namespace.toLowerCase() === "lib") return parsed.path;
  return safeDecode(link).replace(/^frn:lib:/i, "");
}

// --- Per-user Trimble tokens ------------------------------------------------
//
// Every ModelBridge user connects their own Trimble account. The tokens used to
// be two module-level variables, so whoever connected last was the Trimble
// identity for everyone, and one user's "disconnect" logged all of them out.
//
// Each user now has a slot. routes/trimble.ts runs every request inside
// runAsUser(), and AsyncLocalStorage carries the slot down to trimbleGet/Post
// without threading a parameter through every call site. The refresh token is
// persisted per username in state.db so a connection survives a restart.

interface OAuthProgress {
  completed: boolean;
  error: string | null;
  completedAt: string | null;
}

interface TrimbleTokens {
  username: string;
  access: string | null;
  refresh: string | null;
  // One refresh in flight per user: concurrent 401s share it instead of each
  // spending the same (possibly single-use) refresh token.
  refreshing: Promise<string | null> | null;
  oauth: OAuthProgress;
}

function emptySlot(username: string, refresh: string | null): TrimbleTokens {
  return { username, access: null, refresh, refreshing: null, oauth: { completed: false, error: null, completedAt: null } };
}

const tokenScope = new AsyncLocalStorage<TrimbleTokens>();
const slots = new Map<string, TrimbleTokens>();
// The CLI (trimble-cli.ts) is one person in one process and never calls
// runAsUser. The server never writes here: its calls all run inside runAsUser.
const cliSlot = emptySlot("", null);

function tokensFor(username: string): TrimbleTokens {
  let slot = slots.get(username);
  if (!slot) {
    slot = emptySlot(username, getTrimbleRefreshToken(username));
    slots.set(username, slot);
  }
  return slot;
}

function current(): TrimbleTokens {
  return tokenScope.getStore() ?? cliSlot;
}

export function runAsUser<T>(username: string, fn: () => T): T {
  return tokenScope.run(tokensFor(username), fn);
}

function setTokens(slot: TrimbleTokens, access: string | null, refresh: string | null): void {
  slot.access = access;
  slot.refresh = refresh;
  if (slot.username) setTrimbleRefreshToken(slot.username, refresh);
}

export function getOAuthState() {
  const { oauth } = current();
  return {
    completed: oauth.completed,
    error: oauth.error,
    completed_at: oauth.completedAt,
    authenticated: isAuthenticated(),
  };
}

export function markOAuthCompleted(error?: string | null): void {
  const { oauth } = current();
  oauth.completed = true;
  oauth.error = error ?? null;
  oauth.completedAt = new Date().toISOString();
}

// --- OAuth state parameter -------------------------------------------------
//
// The authorize URL previously carried no `state`, and the callback took its
// `redirect_uri` straight from the query string. Together those let anyone who
// could get an operator to open a crafted link complete the flow with their own
// authorization code, binding this app's shared Trimble connection to an account
// they controlled.
//
// Now a single-use state value is minted server-side and stored against the
// callback URL it was issued for. The callback rejects an absent or unknown
// state and takes the redirect_uri from that stored record, never from the
// request. Reuses the single-use token store rather than adding a second one.

const OAUTH_SCOPE = "oauth:trimble-state";

// The callback is a cross-site navigation from id.trimble.com, so it carries no
// session cookie; the state is the only thing that says whose flow it was.
// ponytail: in-memory, so a restart mid-consent makes that one attempt fail
// ("start again"); move into preview_tokens if that ever matters.
const oauthOwners = new Map<string, string>();

export function beginOAuth(callbackUrl: string): { state: string; url: string } {
  const state = randomUUID();
  createPreviewToken(state, callbackKey(callbackUrl), OAUTH_SCOPE);
  oauthOwners.set(state, current().username);
  return { state, url: buildAuthorizeUrl(callbackUrl, state) };
}

// Consumes the state and returns the callback URL it was issued for plus the
// user who started it, or null when it is missing, unknown, expired or already
// spent. The store deletes on first read, so the configured URLs are tried in
// turn until one matches.
export function redeemOAuthState(state: string | undefined): { redirectUri: string; username: string } | null {
  if (!state) return null;
  const username = oauthOwners.get(state);
  oauthOwners.delete(state);
  for (const candidate of getCallbackUrls()) {
    if (consumePreviewToken(state, callbackKey(candidate), OAUTH_SCOPE) === null) {
      // The CLI owns its flows as "" (no user), so test for undefined, not falsy.
      return username === undefined ? null : { redirectUri: candidate, username };
    }
  }
  return null;
}

function callbackKey(callbackUrl: string): string {
  return `cb:${callbackUrl.trim().toLowerCase()}`;
}

const REGION_ENDPOINTS = {
  Core: "https://app21.connect.trimble.com/tc/api/2.0/",
  Model: "https://model-api21.connect.trimble.com/",
  Organizer: "https://org-api.eu-west-1.connect.trimble.com/v1/",
  PSet: "https://pset-api.eu-west-1.connect.trimble.com/v1/",
};

export function getRegionEndpoints() {
  return REGION_ENDPOINTS;
}

export interface ProjectPsetLibrary {
  library_id: string;
  name: string | null;
  raw: Record<string, unknown> | null;
}

// Pset libraries are attached to a project through the Organizer discovery
// tree: forest `project:<id>:data`, tree `ProjectContext`, node `PSetLibs`.
// Each link is FRN-encoded (`frn:lib:<libraryId>`). A missing tree or node just
// means the project has no libraries attached yet.
export async function fetchProjectPsetLibraries(projectId: string): Promise<ProjectPsetLibrary[]> {
  const forestId = `project:${projectId}:data`;
  let node: Record<string, unknown>;
  try {
    node = (await trimbleGet(
      `${REGION_ENDPOINTS.Organizer}forests/${forestId}/trees/ProjectContext/nodes/PSetLibs`,
    )) as Record<string, unknown>;
  } catch {
    return [];
  }

  const links = Array.isArray(node?.links) ? (node.links as unknown[]) : [];
  const ids = [
    ...new Set(
      links
        .filter((l): l is string => typeof l === "string")
        .map(libraryIdFromLink)
        .filter(Boolean),
    ),
  ];
  return Promise.all(ids.map(describePsetLibrary));
}

async function describePsetLibrary(libraryId: string): Promise<ProjectPsetLibrary> {
  try {
    const raw = (await trimbleGet(`${REGION_ENDPOINTS.PSet}libs/${encodeURIComponent(libraryId)}`)) as Record<string, unknown>;
    return { library_id: libraryId, name: (raw?.name as string) ?? null, raw };
  } catch {
    return { library_id: libraryId, name: null, raw: null };
  }
}

function toItems(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const p = raw as Record<string, unknown>;
    return (p.items ?? p.results ?? []) as Record<string, unknown>[];
  }
  return [];
}

// The PSet service pages with an opaque cursor echoed back as `next` — either a
// full URL or a bare skiptoken. Sending `offset` is silently ignored, so an
// offset-based loop re-reads page 1 forever. A full URL is followed verbatim; a
// bare token goes back as the `skiptoken` query parameter. A short (even empty)
// page mid-sequence does not end the walk; only a missing `next` does.
function nextSkipToken(next: unknown): string | null {
  if (typeof next !== "string" || !next.trim()) return null;
  return next.trim();
}

export async function fetchAllPsetPages(
  url: string,
  params: Record<string, string> = {},
  pageSize = 500,
  get: (url: string, params?: Record<string, string>) => Promise<unknown> = (u, p) => trimbleGet(u, p),
): Promise<Record<string, unknown>[]> {
  const MAX_PAGES = 200;
  const out: Record<string, unknown>[] = [];
  let next: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let raw: unknown;
    if (next && next.startsWith("http")) {
      raw = await get(next);
    } else {
      const query: Record<string, string> = { ...params, top: String(pageSize) };
      if (next) query.skiptoken = next;
      raw = await get(url, query);
    }
    out.push(...toItems(raw));
    next = nextSkipToken((raw as Record<string, unknown> | null)?.next);
    if (!next) return out;
  }

  logger.warn(`[trimble] PSet pagination ceiling on ${url}; result is truncated`);
  return out;
}

export interface ProjectPsetDefinition {
  library_id: string;
  library_name: string | null;
  def_id: string;
  name: string;
  properties: { name: string; type?: string; label?: string }[];
}

export interface ProjectPsetInstance {
  link: string;
  entity_id: string;
  library_id: string;
  def_id: string;
  def_name: string;
  props: Record<string, unknown>;
}

interface PsetServiceInstance {
  link: string;
  libId: string;
  defId: string;
  v: number;
  schemaV: number;
  props: Record<string, unknown>;
}

function extractEntityId(link: string): string {
  try {
    const decoded = decodeURIComponent(link);
    const match = /entity:([^/]+)$/.exec(decoded);
    return match ? match[1] : link;
  } catch {
    return link;
  }
}

async function fetchPsetDefinitions(libIds: string[]): Promise<ProjectPsetDefinition[]> {
  const definitions: ProjectPsetDefinition[] = [];

  for (const libId of libIds) {
    let defs: Record<string, unknown>[] = [];
    try {
      defs = await fetchAllPsetPages(`${REGION_ENDPOINTS.PSet}libs/${encodeURIComponent(libId)}/defs`);
    } catch {
      continue;
    }
    for (const d of defs) {
      const defId = String(d.id ?? "");
      if (!defId) continue;
      const propsObj = ((d.schema as Record<string, unknown>)?.props ?? {}) as Record<string, { type?: string }>;
      const i18n = (d.i18n ?? {}) as Record<string, { name?: string; props?: Record<string, string> }>;
      const locale = pickLocale(i18n);
      const labels = collectPropLabels(i18n, locale.props ?? {});
      definitions.push({
        library_id: libId,
        library_name: null,
        def_id: defId,
        name: locale.name || String(d.name ?? defId),
        properties: Object.entries(propsObj).map(([name, meta]) => ({
          name,
          type: meta?.type,
          label: labels[name],
        })),
      });
    }
  }

  return definitions;
}

// Property labels live under an i18n locale, but not every locale translates
// every property (and pickLocale returns only one). Merge across locales so a
// property name resolves whenever any locale provides it.
function collectPropLabels(
  i18n: Record<string, { name?: string; props?: Record<string, string> }>,
  preferred: Record<string, string>,
): Record<string, string> {
  const labels: Record<string, string> = { ...preferred };
  for (const [key, loc] of Object.entries(i18n)) {
    if (key.startsWith("__")) continue;
    for (const [propId, value] of Object.entries(loc?.props ?? {})) {
      if (!labels[propId] && value) labels[propId] = value;
    }
  }
  return labels;
}

function renamePsetProps(props: Record<string, unknown>, def?: ProjectPsetDefinition): Record<string, unknown> {
  if (!def) return props;
  const renameMap = new Map<string, string>();
  for (const prop of def.properties) {
    renameMap.set(prop.name, prop.label ?? prop.name);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    out[renameMap.get(key) ?? key] = value;
  }
  return out;
}

// Property-set libraries attached to the project (Organizer discovery tree) and
// the definitions inside them (PSet service). This is where properties added
// through Trimble Connect live — they are NOT part of the IFC file, so the model
// API's `psets` field never contains them.
export async function fetchProjectPsetCatalog(
  projectId: string,
): Promise<{ libraries: ProjectPsetLibrary[]; definitions: ProjectPsetDefinition[] }> {
  const libraries = await fetchProjectPsetLibraries(projectId);
  const libIds = libraries.map((l) => l.library_id);
  const definitions = await fetchPsetDefinitions(libIds);
  const libNameMap = new Map(libraries.map((l) => [l.library_id, l.name]));
  return {
    libraries,
    definitions: definitions.map((d) => ({ ...d, library_name: libNameMap.get(d.library_id) ?? null })),
  };
}

// Pset instances for a single FRN link. Searches across all definitions and
// libraries attached to that object.
export async function fetchPsetsByLink(link: string): Promise<PsetServiceInstance[]> {
  const items = await fetchAllPsetPages(`${REGION_ENDPOINTS.PSet}psets/${encodeURIComponent(link)}`);
  return items as unknown as PsetServiceInstance[];
}

interface PsetIdentityRef {
  link: string;
  libId: string;
  defId: string;
}

interface PsetBatchGetResponse {
  unprocessed?: { psets?: PsetIdentityRef[] };
  responses?: { psets?: PsetServiceInstance[] };
  errors?: { psets?: Array<{ item: PsetIdentityRef; code: string; message: string }> };
}

// The PSet batch-get API rejects requests with more than 100 items.
const PSET_BATCH_CHUNK_SIZE = 100;
const PSET_BATCH_CONCURRENCY = 6;
const BATCH_GET_MAX_ATTEMPTS = 3;

// Fetch psets for a set of model entities and resolve only the definitions that
// actually returned data. With `projectId` given, discovery is definition-scoped:
// list the project libraries' definitions once, then batch-get the psets of all
// entity links per definition (POST /batch-get, ≤100 identities per call) —
// a few dozen requests instead of one GET per entity. Without `projectId` the
// legacy per-entity discovery remains as the fallback.
export async function fetchEntityPsets(
  entityGuids: string[],
  options: { concurrency?: number; projectId?: string } = {},
): Promise<ProjectPsetInstance[]> {
  const guids = [...new Set(entityGuids)];
  if (guids.length === 0) return [];

  if (options.projectId) {
    try {
      return await fetchEntityPsetsBatched(guids, options.projectId);
    } catch (e) {
      logger.warn(
        `[trimble] batched pset fetch failed for project ${options.projectId}, falling back to per-entity: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return fetchEntityPsetsPerLink(guids, options.concurrency ?? 5);
}

async function fetchEntityPsetsBatched(entityGuids: string[], projectId: string): Promise<ProjectPsetInstance[]> {
  const libraries = await fetchProjectPsetLibraries(projectId);
  const libIds = libraries.map((l) => l.library_id).filter(Boolean);
  if (libIds.length === 0) return [];

  const definitions = await fetchPsetDefinitions(libIds);
  const pairs = new Map<string, ProjectPsetDefinition>();
  for (const def of definitions) pairs.set(`${def.library_id}|${def.def_id}`, def);
  if (pairs.size === 0) return [];

  const refs: PsetIdentityRef[] = [...pairs.values()].flatMap((def) =>
    entityGuids.map((guid) => ({ link: `frn:entity:${guid}`, libId: def.library_id, defId: def.def_id })),
  );
  const chunks: PsetIdentityRef[][] = [];
  for (let i = 0; i < refs.length; i += PSET_BATCH_CHUNK_SIZE) {
    chunks.push(refs.slice(i, i + PSET_BATCH_CHUNK_SIZE));
  }

  logger.info(
    `[trimble] batch-get psets: ${entityGuids.length} entities × ${pairs.size} definitions → ${chunks.length} requests`,
  );

  const rawInstances: PsetServiceInstance[] = [];
  let chunksDone = 0;

  const fetchChunk = async (initial: PsetIdentityRef[]): Promise<void> => {
    let pending = initial;
    for (let attempt = 0; attempt < BATCH_GET_MAX_ATTEMPTS && pending.length > 0; attempt++) {
      const response = (await trimblePost(`${REGION_ENDPOINTS.PSet}batch-get`, { psets: pending })) as PsetBatchGetResponse;
      rawInstances.push(...(response.responses?.psets ?? []));
      // Entity/definition combinations without a pset come back as per-item errors; expected.
      pending = response.unprocessed?.psets ?? [];
    }
    if (pending.length > 0) {
      logger.warn(`[trimble] batch-get left ${pending.length} psets unprocessed`);
    }
    chunksDone++;
    if (chunksDone % 25 === 0 || chunksDone === chunks.length) {
      logger.info(`[trimble] pset batches: ${chunksDone}/${chunks.length}, ${rawInstances.length} instances so far`);
    }
  };

  let nextChunk = 0;
  const workers = Array.from({ length: Math.min(PSET_BATCH_CONCURRENCY, chunks.length) }, async () => {
    while (nextChunk < chunks.length) {
      await fetchChunk(chunks[nextChunk++]!);
    }
  });
  await Promise.all(workers);

  return resolvePsetInstances(rawInstances, definitions);
}

async function fetchEntityPsetsPerLink(
  entityGuids: string[],
  concurrency: number,
): Promise<ProjectPsetInstance[]> {
  const rawInstances: PsetServiceInstance[] = [];

  for (let i = 0; i < entityGuids.length; i += concurrency) {
    const batch = entityGuids.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((guid) => fetchPsetsByLink(`frn:entity:${guid}`)));
    for (const list of results) {
      rawInstances.push(...list);
    }
  }

  if (rawInstances.length === 0) {
    return [];
  }

  const libIds = [...new Set(rawInstances.map((r) => r.libId))];
  const definitions = await fetchPsetDefinitions(libIds);
  return resolvePsetInstances(rawInstances, definitions);
}

function resolvePsetInstances(
  rawInstances: PsetServiceInstance[],
  definitions: ProjectPsetDefinition[],
): ProjectPsetInstance[] {
  const defMap = new Map<string, ProjectPsetDefinition>();
  for (const def of definitions) {
    defMap.set(`${def.library_id}|${def.def_id}`, def);
  }

  return rawInstances.map((raw) => {
    const def = defMap.get(`${raw.libId}|${raw.defId}`);
    return {
      link: raw.link,
      entity_id: extractEntityId(raw.link),
      library_id: raw.libId,
      def_id: raw.defId,
      def_name: def?.name ?? raw.defId,
      props: renamePsetProps(raw.props, def),
    };
  });
}

export function isAuthenticated(): boolean {
  const t = current();
  return Boolean(t.access || t.refresh);
}

export function clearTokens(): void {
  setTokens(current(), null, null);
}

export function setManualToken(token: string, refresh?: string | null): void {
  setTokens(current(), token.trim() || null, refresh?.trim() || null);
}

export function getCallbackUrls(): string[] {
  return env.TRIMBLE_CALLBACK_URLS;
}

export function buildAuthorizeUrl(callbackUrl?: string, state?: string): string {
  const redirectUri = callbackUrl ?? env.TRIMBLE_CALLBACK_URLS[0];
  const params = new URLSearchParams({
    scope: env.TRIMBLE_SCOPE,
    response_type: "code",
    redirect_uri: redirectUri,
    client_id: env.TRIMBLE_CLIENT_ID,
  });
  if (state) params.set("state", state);
  return `${env.TRIMBLE_AUTHORIZE_URI}?${params}`;
}

// A callback URL is usable only if it is one we were configured with.
export function isConfiguredCallback(url: string | undefined): url is string {
  if (!url) return false;
  const want = url.trim().toLowerCase();
  return getCallbackUrls().some((u) => u.trim().toLowerCase() === want);
}

async function tokenExchange(payload: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(env.TRIMBLE_TOKEN_URI, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(payload),
  });
  if (!res.ok) throw new Error(`Trimble token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function exchangeCode(code: string, redirectUri?: string): Promise<Record<string, unknown>> {
  const callbackUrl = redirectUri ?? env.TRIMBLE_CALLBACK_URLS[0];
  const data = await tokenExchange({
    grant_type: "authorization_code",
    code,
    client_id: env.TRIMBLE_CLIENT_ID,
    client_secret: env.TRIMBLE_CLIENT_SECRET,
    redirect_uri: callbackUrl,
  });
  setManualToken(data.access_token as string, data.refresh_token as string | undefined);
  return data;
}

function refreshAccessToken(slot: TrimbleTokens): Promise<string | null> {
  if (!slot.refresh) return Promise.resolve(null);
  slot.refreshing ??= (async () => {
    try {
      const data = await tokenExchange({
        grant_type: "refresh_token",
        refresh_token: slot.refresh!,
        client_id: env.TRIMBLE_CLIENT_ID,
        client_secret: env.TRIMBLE_CLIENT_SECRET,
        redirect_uri: env.TRIMBLE_CALLBACK_URLS[0],
      });
      setTokens(slot, (data.access_token as string) ?? slot.access, (data.refresh_token as string) ?? slot.refresh);
      logger.debug(`[trimble] refreshed access token for "${slot.username || "cli"}"`);
      return slot.access;
    } finally {
      slot.refreshing = null;
    }
  })();
  return slot.refreshing;
}

export async function trimbleGet(url: string, params?: Record<string, string>): Promise<unknown> {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const slot = current();
  const h: Record<string, string> = {};
  if (slot.access) h.Authorization = `Bearer ${slot.access}`;
  const started = Date.now();

  try {
    let res = await fetch(`${url}${qs}`, { headers: h });
    if (res.status === 401 && slot.refresh) {
      const refreshed = await refreshAccessToken(slot);
      if (refreshed) {
        h.Authorization = `Bearer ${refreshed}`;
        res = await fetch(`${url}${qs}`, { headers: h });
      }
    }
    if (!res.ok) {
      recordEvent({ category: "trimble", level: "error", summary: `GET ${url}`, detail: `${res.status} · ${Date.now() - started}ms` });
      throw new Error(`Trimble GET ${url}: ${res.status}`);
    }
    const json = await res.json();
    recordEvent({ category: "trimble", level: "info", summary: `GET ${url}`, detail: `${res.status} · ${Date.now() - started}ms` });
    return json;
  } catch (e) {
    if (e instanceof Error && !e.message.startsWith("Trimble GET")) {
      recordEvent({ category: "trimble", level: "error", summary: `GET ${url}`, detail: e.message });
    }
    throw e;
  }
}

export async function trimblePost(url: string, body: unknown): Promise<unknown> {
  const slot = current();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (slot.access) h.Authorization = `Bearer ${slot.access}`;
  const started = Date.now();

  try {
    const init = (): RequestInit => ({ method: "POST", headers: h, body: JSON.stringify(body) });
    let res = await fetch(url, init());
    if (res.status === 401 && slot.refresh) {
      const refreshed = await refreshAccessToken(slot);
      if (refreshed) {
        h.Authorization = `Bearer ${refreshed}`;
        res = await fetch(url, init());
      }
    }
    if (!res.ok) {
      recordEvent({ category: "trimble", level: "error", summary: `POST ${url}`, detail: `${res.status} · ${Date.now() - started}ms` });
      throw new Error(`Trimble POST ${url}: ${res.status}`);
    }
    const json = await res.json();
    recordEvent({ category: "trimble", level: "info", summary: `POST ${url}`, detail: `${res.status} · ${Date.now() - started}ms` });
    return json;
  } catch (e) {
    if (e instanceof Error && !e.message.startsWith("Trimble POST")) {
      recordEvent({ category: "trimble", level: "error", summary: `POST ${url}`, detail: e.message });
    }
    throw e;
  }
}

export async function fetchAllTrimblePages(
  url: string,
  pageSize = 1000,
  extraParams?: Record<string, string>,
): Promise<unknown[]> {
  const MAX_PAGES = 500;
  const all: unknown[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await trimbleGet(url, { ...extraParams, top: String(pageSize), offset: String(offset) });
    let items: unknown[] = [];
    let offsetNext: number | null | undefined;

    if (Array.isArray(raw)) {
      items = raw;
    } else if (raw && typeof raw === "object") {
      const p = raw as Record<string, unknown>;
      items = (p.results ?? p.items ?? p.entities ?? []) as unknown[];
      if (typeof p.offsetNext === "number") offsetNext = p.offsetNext;
      else if (p.offsetNext === null) offsetNext = null;
    }

    all.push(...items);

    // The model API reports the next offset explicitly (null = last page); a
    // short page can also happen because of its response-size cap, so trusting
    // "items < pageSize" alone would silently truncate the result.
    if (offsetNext === null) return all;
    if (typeof offsetNext === "number") {
      offset = offsetNext;
      continue;
    }
    if (items.length < pageSize) return all;
    offset += pageSize;
  }

  logger.warn(`[trimble] fetchAllTrimblePages hit the ${MAX_PAGES}-page ceiling on ${url}; result is truncated`);
  return all;
}
