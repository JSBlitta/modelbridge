import Database from "better-sqlite3";
import { resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "state.db");
let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
  }
  return _db;
}

// better-sqlite3 does not cache prepared statements, so re-preparing the same
// SQL on every call recompiles it. Memoize by SQL string; a statement is valid
// for the lifetime of the connection, which is never reopened.
const _stmtCache = new Map<string, Database.Statement>();
function prep(sql: string): Database.Statement {
  let stmt = _stmtCache.get(sql);
  if (!stmt) {
    stmt = db().prepare(sql);
    _stmtCache.set(sql, stmt);
  }
  return stmt;
}

export function initDb(): void {
  const d = db();
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  // Migration: drop token columns if upgrading from v1 schema
  const cols = d.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (cols.some((c) => c.name === "access_token")) {
    d.exec(`
      CREATE TABLE sessions_v2 (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      INSERT INTO sessions_v2 SELECT id, username, email, created_at, expires_at FROM sessions
        WHERE expires_at > datetime('now');
      DROP TABLE sessions;
      ALTER TABLE sessions_v2 RENAME TO sessions;
    `);
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      uuid TEXT PRIMARY KEY,
      name TEXT,
      project_uuid TEXT,
      phase TEXT,
      linked_stdlibs TEXT,
      state TEXT DEFAULT 'provisional',
      created_at TEXT,
      updated_at TEXT
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS column_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      mapping TEXT
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS reporting_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      frequency TEXT NOT NULL,
      weekdays TEXT NOT NULL DEFAULT '[]',
      day_of_month INTEGER,
      conditions TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL DEFAULT '',
      overwrite INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS preview_tokens (
      token TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  ensureTrimbleCacheSchema(d);
  d.exec(`
    CREATE TABLE IF NOT EXISTS trimble_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT,
      raw TEXT,
      fetched_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS trimble_models (
      model_id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT,
      raw TEXT,
      fetched_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS trimble_libraries (
      library_id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT,
      raw TEXT,
      fetched_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS trimble_model_libraries (
      model_id TEXT NOT NULL,
      project_id TEXT,
      library_id TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (model_id, library_id)
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS trimble_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
  ensureEventsTable();
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(project_uuid);
    CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
    CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
    CREATE INDEX IF NOT EXISTS idx_preview_tokens_expires ON preview_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_trimble_models_project ON trimble_models(project_id);
    CREATE INDEX IF NOT EXISTS idx_trimble_libraries_project ON trimble_libraries(project_id);
    CREATE INDEX IF NOT EXISTS idx_trimble_model_libraries_project ON trimble_model_libraries(project_id);
  `);
}

let _eventsReady = false;

function ensureEventsTable(): void {
  if (_eventsReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      category TEXT NOT NULL,
      level TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT
    )
  `);
  _eventsReady = true;
}

// The Trimble tables are a pure, rebuildable cache. An older installation may
// have created them with a different shape, which `CREATE TABLE IF NOT EXISTS`
// cannot fix (it leaves an existing table untouched) — so bump the version and
// drop them once, letting the CREATE statements in initDb rebuild them.
const TRIMBLE_CACHE_VERSION = 1;

function ensureTrimbleCacheSchema(d: Database.Database): void {
  const row = d.prepare("SELECT value FROM settings WHERE key = ?").get("trimble_cache_version") as
    | { value: string }
    | undefined;
  if (row && Number(row.value) >= TRIMBLE_CACHE_VERSION) return;

  d.exec(`
    DROP TABLE IF EXISTS trimble_model_libraries;
    DROP TABLE IF EXISTS trimble_libraries;
    DROP TABLE IF EXISTS trimble_models;
    DROP TABLE IF EXISTS trimble_projects;
    DROP TABLE IF EXISTS trimble_cache;
  `);
  d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "trimble_cache_version",
    String(TRIMBLE_CACHE_VERSION),
  );
}

// --- Event history (persistent action log) ---

export interface EventRow {
  id: number;
  ts: string;
  category: string;
  level: string;
  summary: string;
  detail: string | null;
}

const MAX_EVENTS = 5000;
// Pruning the event table on every insert costs a scan + sort of up to MAX_EVENTS
// rows on the request path. Instead, prune every Nth insert; the table can only
// briefly exceed the cap by PRUNE_EVERY rows.
const PRUNE_EVERY = 200;
let _eventsSincePrune = 0;

// Record a single action into the persistent history.
// Categories: "produuzit" (API actions), "trimble" (API actions), "reporting" (scheduled exports).
export function recordEvent(input: {
  category: string;
  level?: string;
  summary: string;
  detail?: string;
}): void {
  try {
    ensureEventsTable();
    prep("INSERT INTO events (ts, category, level, summary, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), input.category, input.level ?? "info", input.summary, input.detail ?? null);
    // Keep the table bounded — retain the most recent events only
    if (++_eventsSincePrune >= PRUNE_EVERY) {
      _eventsSincePrune = 0;
      prep("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)").run(MAX_EVENTS);
    }
  } catch {
    // History must never break the action it is recording
  }
}

export function listEvents(opts?: { limit?: number; category?: string; level?: string }): EventRow[] {
  ensureEventsTable();
  const limit = Math.min(opts?.limit ?? 100, 1000);
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts?.category) { conds.push("category = ?"); args.push(opts.category); }
  if (opts?.level) { conds.push("level = ?"); args.push(opts.level); }
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  return prep(`SELECT * FROM events${where} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as EventRow[];
}

export function clearEvents(category?: string): void {
  ensureEventsTable();
  if (category) prep("DELETE FROM events WHERE category = ?").run(category);
  else prep("DELETE FROM events").run();
}

export function upsertBatch(
  uuid: string,
  name: string,
  projectUuid: string,
  phase: string,
  linkedStdlibs?: string[] | null,
  state?: string,
): void {
  const now = new Date().toISOString();
  const stdlibJson = linkedStdlibs ? JSON.stringify(linkedStdlibs) : null;
  const d = db();
  // Preserve the existing state on update unless explicitly overridden.
  // Without this, every re-import silently reset definitive batches to provisional.
  const existing = state === undefined
    ? (d.prepare("SELECT state FROM batches WHERE uuid=?").get(uuid) as { state?: string } | undefined)
    : undefined;
  const effectiveState = state ?? existing?.state ?? "provisional";
  d
    .prepare(
      `INSERT INTO batches (uuid, name, project_uuid, phase, linked_stdlibs, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         name=excluded.name, project_uuid=excluded.project_uuid,
         phase=excluded.phase, linked_stdlibs=excluded.linked_stdlibs,
         state=excluded.state, updated_at=excluded.updated_at`,
    )
    .run(uuid, name, projectUuid, phase, stdlibJson, effectiveState, now, now);
}

export interface BatchRow {
  uuid: string;
  name: string;
  project_uuid: string;
  phase: string;
  linked_stdlibs: string[] | null;
  state: string;
  created_at: string;
  updated_at: string;
}

export function getBatches(projectUuid?: string): BatchRow[] {
  const d = db();
  const rows = projectUuid
    ? d.prepare("SELECT * FROM batches WHERE project_uuid=?").all(projectUuid) as Record<string, unknown>[]
    : d.prepare("SELECT * FROM batches").all() as Record<string, unknown>[];
  return rows.map((r) => {
    let stdlibs: string[] | null = null;
    if (typeof r.linked_stdlibs === "string") {
      try { stdlibs = JSON.parse(r.linked_stdlibs); } catch { stdlibs = null; }
    }
    return { ...r, linked_stdlibs: stdlibs } as BatchRow;
  });
}

export function setBatchState(batchUuids: string[], state: string): void {
  const now = new Date().toISOString();
  const d = db();
  const placeholders = batchUuids.map(() => "?").join(",");
  d.prepare(
    `UPDATE batches SET state=?, updated_at=? WHERE uuid IN (${placeholders})`,
  ).run(state, now, ...batchUuids);
}

export function savePreset(name: string, mapping: Record<string, string>): void {
  prep("INSERT OR REPLACE INTO column_presets (name, mapping) VALUES (?, ?)")
    .run(name, JSON.stringify(mapping));
}

export function getPresets(): { id: number; name: string; mapping: Record<string, string> }[] {
  const rows = prep("SELECT * FROM column_presets").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    mapping: JSON.parse(r.mapping as string),
  }));
}

// --- Sessions ---

export interface SessionRow {
  id: string;
  username: string;
  email: string;
  created_at: string;
  expires_at: string;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export function createSession(id: string, username: string, email: string): SessionRow {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const row: SessionRow = {
    id, username, email,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  prep(`INSERT INTO sessions (id, username, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, username, email, row.created_at, row.expires_at);
  return row;
}

export function getSession(id: string): SessionRow | null {
  const row = prep("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    prep("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  return row;
}

export function deleteSession(id: string): void {
  prep("DELETE FROM sessions WHERE id = ?").run(id);
}

export function pruneExpiredSessions(): void {
  prep("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
}

// --- Settings (key/value, admin-editable) ---

export function getAllSettings(): Record<string, string> {
  const rows = prep("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSettings(entries: Record<string, unknown>): void {
  const d = db();
  const stmt = d.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  const tx = d.transaction((pairs: [string, string][]) => {
    for (const [k, v] of pairs) stmt.run(k, v);
  });
  tx(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
}

// --- Reporting schedule (replaces the SharePoint list CSV) ---

export interface ReportingScheduleRow {
  id: number;
  endpoint: string;
  active: number;
  frequency: string;
  weekdays: string; // JSON array
  day_of_month: number | null;
  conditions: string;
  storage_path: string;
  overwrite: number;
  position: number;
}

export function listReportingSchedule(): ReportingScheduleRow[] {
  return prep("SELECT * FROM reporting_schedule ORDER BY position, id").all() as ReportingScheduleRow[];
}

export function upsertReportingSchedule(entry: {
  id?: number | null;
  endpoint: string;
  active: boolean;
  frequency: string;
  weekdays: string[];
  day_of_month: number | null;
  conditions: string;
  storage_path: string;
  overwrite: boolean;
  position?: number;
}): number {
  const d = db();
  const weekdaysJson = JSON.stringify(entry.weekdays ?? []);
  if (entry.id) {
    d.prepare(
      `UPDATE reporting_schedule SET
         endpoint=?, active=?, frequency=?, weekdays=?, day_of_month=?, conditions=?, storage_path=?, overwrite=?, position=?
       WHERE id=?`,
    ).run(
      entry.endpoint, entry.active ? 1 : 0, entry.frequency, weekdaysJson, entry.day_of_month,
      entry.conditions ?? "", entry.storage_path ?? "", entry.overwrite ? 1 : 0,
      entry.position ?? 0, entry.id,
    );
    return entry.id;
  }
  const position = entry.position ?? (listReportingSchedule().length + 1);
  const info = d.prepare(
    `INSERT INTO reporting_schedule (endpoint, active, frequency, weekdays, day_of_month, conditions, storage_path, overwrite, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.endpoint, entry.active ? 1 : 0, entry.frequency, weekdaysJson, entry.day_of_month,
    entry.conditions ?? "", entry.storage_path ?? "", entry.overwrite ? 1 : 0, position,
  );
  return Number(info.lastInsertRowid);
}

export function deleteReportingSchedule(id: number): void {
  prep("DELETE FROM reporting_schedule WHERE id = ?").run(id);
}

// --- Preview tokens (preview -> import gate) ---
//
// A token is issued by a /preview* endpoint, bound to the fingerprint of the
// payload it previewed, and consumed exactly once by the matching execute
// endpoint. Single-use is why these live in the DB rather than being a signed
// HMAC: revocation-on-use needs server state regardless.

const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function createPreviewToken(token: string, fingerprintHex: string, scope: string): void {
  const now = new Date();
  prep(
      "INSERT INTO preview_tokens (token, fingerprint, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      token,
      fingerprintHex,
      scope,
      now.toISOString(),
      new Date(now.getTime() + PREVIEW_TOKEN_TTL_MS).toISOString(),
    );
}

export type PreviewTokenFailure = "missing" | "unknown" | "expired" | "scope" | "mismatch";

// Atomically consume a token. Returns null on success, or the reason it failed.
// The DELETE is what makes it single-use; doing it in the same transaction as
// the read closes the replay window between two concurrent imports.
export function consumePreviewToken(
  token: string | undefined,
  fingerprintHex: string,
  scope: string,
): PreviewTokenFailure | null {
  if (!token) return "missing";
  const d = db();
  const run = d.transaction((): PreviewTokenFailure | null => {
    const row = d
      .prepare("SELECT fingerprint, scope, expires_at FROM preview_tokens WHERE token = ?")
      .get(token) as { fingerprint: string; scope: string; expires_at: string } | undefined;
    if (!row) return "unknown";
    d.prepare("DELETE FROM preview_tokens WHERE token = ?").run(token);
    if (new Date(row.expires_at) < new Date()) return "expired";
    if (row.scope !== scope) return "scope";
    if (row.fingerprint !== fingerprintHex) return "mismatch";
    return null;
  });
  return run();
}

export function pruneExpiredPreviewTokens(): void {
  prep("DELETE FROM preview_tokens WHERE expires_at < ?").run(new Date().toISOString());
}

// --- Trimble discovery cache ---
//
// Trimble's project/model/pset-library topology changes rarely but is expensive
// to discover (the tree fan-out walks every folder and release). We persist it
// until an admin explicitly force-refreshes, so imports read it instantly.

export interface TrimbleProjectRow {
  project_id: string;
  name: string | null;
  raw: Record<string, unknown> | null;
  fetched_at: string;
}

export interface TrimbleModelRow {
  model_id: string;
  project_id: string | null;
  name: string | null;
  raw: Record<string, unknown> | null;
  fetched_at: string;
}

export interface TrimbleLibraryRow {
  library_id: string;
  project_id: string | null;
  name: string | null;
  raw: Record<string, unknown> | null;
  fetched_at: string;
}

export interface TrimbleModelLibraryRow {
  model_id: string;
  project_id: string | null;
  library_id: string;
  fetched_at: string;
}

export interface TrimbleCacheEntry {
  value: unknown;
  fetched_at: string;
}

export interface TrimbleCacheStats {
  projects: number;
  models: number;
  libraries: number;
  model_libraries: number;
  cache_entries: number;
  last_refreshed_at: string | null;
}

function decodeRaw(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
}

// Replace the cached project list wholesale. Projects that disappeared upstream
// (and their models/libraries) are pruned so stale ids cannot be imported.
export function upsertTrimbleProjects(
  projects: { project_id: string; name?: string | null; raw?: Record<string, unknown> | null }[],
): void {
  const d = db();
  const now = new Date().toISOString();
  const insert = d.prepare(
    `INSERT INTO trimble_projects (project_id, name, raw, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       name=excluded.name, raw=excluded.raw, fetched_at=excluded.fetched_at`,
  );
  const tx = d.transaction((rows: typeof projects) => {
    for (const r of rows) insert.run(r.project_id, r.name ?? null, r.raw ? JSON.stringify(r.raw) : null, now);
    if (!rows.length) {
      d.prepare("DELETE FROM trimble_model_libraries").run();
      d.prepare("DELETE FROM trimble_libraries").run();
      d.prepare("DELETE FROM trimble_models").run();
      d.prepare("DELETE FROM trimble_projects").run();
      return;
    }
    const ids = rows.map((r) => r.project_id);
    const ph = ids.map(() => "?").join(",");
    d.prepare(`DELETE FROM trimble_models WHERE project_id IS NOT NULL AND project_id NOT IN (${ph})`).run(...ids);
    d.prepare(`DELETE FROM trimble_libraries WHERE project_id IS NOT NULL AND project_id NOT IN (${ph})`).run(...ids);
    d.prepare(`DELETE FROM trimble_model_libraries WHERE project_id IS NOT NULL AND project_id NOT IN (${ph})`).run(...ids);
    d.prepare(`DELETE FROM trimble_projects WHERE project_id NOT IN (${ph})`).run(...ids);
  });
  tx(projects);
}

export function getTrimbleProjects(): TrimbleProjectRow[] {
  const rows = prep("SELECT * FROM trimble_projects ORDER BY name, project_id").all() as Record<string, unknown>[];
  return rows.map((r) => ({ ...r, raw: decodeRaw(r.raw as string | null) })) as TrimbleProjectRow[];
}

// Replace the cached model list for one project. Models removed upstream are
// pruned together with their library links.
export function upsertTrimbleModels(
  projectId: string,
  models: { model_id: string; name?: string | null; raw?: Record<string, unknown> | null }[],
): void {
  const d = db();
  const now = new Date().toISOString();
  const insert = d.prepare(
    `INSERT INTO trimble_models (model_id, project_id, name, raw, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(model_id) DO UPDATE SET
       project_id=excluded.project_id, name=excluded.name, raw=excluded.raw, fetched_at=excluded.fetched_at`,
  );
  const tx = d.transaction((rows: typeof models) => {
    for (const r of rows) insert.run(r.model_id, projectId, r.name ?? null, r.raw ? JSON.stringify(r.raw) : null, now);
    d.prepare("DELETE FROM trimble_model_libraries WHERE project_id = ?").run(projectId);
    if (rows.length) {
      const ids = rows.map((r) => r.model_id);
      const ph = ids.map(() => "?").join(",");
      d.prepare(`DELETE FROM trimble_models WHERE project_id = ? AND model_id NOT IN (${ph})`).run(projectId, ...ids);
    } else {
      d.prepare("DELETE FROM trimble_models WHERE project_id = ?").run(projectId);
    }
  });
  tx(models);
  relinkTrimbleProjectLibraries(projectId);
}

export function getTrimbleModels(projectId?: string): TrimbleModelRow[] {
  const rows = projectId
    ? prep("SELECT * FROM trimble_models WHERE project_id = ? ORDER BY name, model_id").all(projectId)
    : prep("SELECT * FROM trimble_models ORDER BY project_id, name, model_id").all();
  return (rows as Record<string, unknown>[]).map((r) => ({ ...r, raw: decodeRaw(r.raw as string | null) })) as TrimbleModelRow[];
}

// Replace the discovered libraries for one project, then relink every cached
// model of that project to each library. Pset libraries are attached at project
// level in Trimble (the Organizer ProjectContext/PSetLibs node); mapping them
// per model is what the import needs to report.
export function replaceTrimbleProjectLibraries(
  projectId: string,
  libraries: { library_id: string; name?: string | null; raw?: Record<string, unknown> | null }[],
): void {
  const d = db();
  const now = new Date().toISOString();
  const insert = d.prepare(
    `INSERT INTO trimble_libraries (library_id, project_id, name, raw, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(library_id) DO UPDATE SET
       project_id=excluded.project_id, name=excluded.name, raw=excluded.raw, fetched_at=excluded.fetched_at`,
  );
  const tx = d.transaction((libs: typeof libraries) => {
    if (libs.length) {
      const ids = libs.map((l) => l.library_id);
      const ph = ids.map(() => "?").join(",");
      d.prepare(`DELETE FROM trimble_libraries WHERE project_id = ? AND library_id NOT IN (${ph})`).run(projectId, ...ids);
    } else {
      d.prepare("DELETE FROM trimble_libraries WHERE project_id = ?").run(projectId);
    }
    for (const lib of libs) {
      insert.run(lib.library_id, projectId, lib.name ?? null, lib.raw ? JSON.stringify(lib.raw) : null, now);
    }
  });
  tx(libraries);
  relinkTrimbleProjectLibraries(projectId);
}

// Recompute model -> library links for a project from whatever is currently
// cached on both sides. Called after the model list or the library list changes.
export function relinkTrimbleProjectLibraries(projectId: string): void {
  const d = db();
  const now = new Date().toISOString();
  const libs = d.prepare("SELECT library_id FROM trimble_libraries WHERE project_id = ?").all(projectId) as { library_id: string }[];
  const models = d.prepare("SELECT model_id FROM trimble_models WHERE project_id = ?").all(projectId) as { model_id: string }[];
  const link = d.prepare(
    `INSERT INTO trimble_model_libraries (model_id, project_id, library_id, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(model_id, library_id) DO UPDATE SET
       project_id=excluded.project_id, fetched_at=excluded.fetched_at`,
  );
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM trimble_model_libraries WHERE project_id = ?").run(projectId);
    for (const m of models) {
      for (const lib of libs) link.run(m.model_id, projectId, lib.library_id, now);
    }
  });
  tx();
}

export function getTrimbleLibraries(projectId?: string): TrimbleLibraryRow[] {
  const rows = projectId
    ? prep("SELECT * FROM trimble_libraries WHERE project_id = ? ORDER BY name, library_id").all(projectId)
    : prep("SELECT * FROM trimble_libraries ORDER BY project_id, name, library_id").all();
  return (rows as Record<string, unknown>[]).map((r) => ({ ...r, raw: decodeRaw(r.raw as string | null) })) as TrimbleLibraryRow[];
}

export function getTrimbleModelLibraries(): TrimbleModelLibraryRow[] {
  const rows = prep("SELECT * FROM trimble_model_libraries").all();
  return rows as TrimbleModelLibraryRow[];
}

// Generic JSON cache for the other read-through endpoints (tree, releases,
// files, psetdefs). Keyed by a stable string such as `tree:<projectId>`.
export function setTrimbleCache(key: string, value: unknown): void {
  prep(
      `INSERT INTO trimble_cache (cache_key, value, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at`,
    )
    .run(key, JSON.stringify(value ?? null), new Date().toISOString());
}

export function getTrimbleCache(key: string): TrimbleCacheEntry | null {
  const row = prep("SELECT value, fetched_at FROM trimble_cache WHERE cache_key = ?").get(key) as
    | { value: string; fetched_at: string }
    | undefined;
  if (!row) return null;
  let value: unknown = null;
  try { value = JSON.parse(row.value); } catch { value = null; }
  return { value, fetched_at: row.fetched_at };
}

export function clearTrimbleCache(): { projects: number; models: number; libraries: number; model_libraries: number; cache_entries: number } {
  const d = db();
  const counts = {
    projects: (d.prepare("SELECT COUNT(*) AS n FROM trimble_projects").get() as { n: number }).n,
    models: (d.prepare("SELECT COUNT(*) AS n FROM trimble_models").get() as { n: number }).n,
    libraries: (d.prepare("SELECT COUNT(*) AS n FROM trimble_libraries").get() as { n: number }).n,
    model_libraries: (d.prepare("SELECT COUNT(*) AS n FROM trimble_model_libraries").get() as { n: number }).n,
    cache_entries: (d.prepare("SELECT COUNT(*) AS n FROM trimble_cache").get() as { n: number }).n,
  };
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM trimble_model_libraries").run();
    d.prepare("DELETE FROM trimble_libraries").run();
    d.prepare("DELETE FROM trimble_models").run();
    d.prepare("DELETE FROM trimble_projects").run();
    d.prepare("DELETE FROM trimble_cache").run();
  });
  tx();
  return counts;
}

// Most recent fetch across every cache surface; null when nothing is cached yet.
export function getTrimbleCacheStats(): TrimbleCacheStats {
  const d = db();
  const counts = {
    projects: (d.prepare("SELECT COUNT(*) AS n FROM trimble_projects").get() as { n: number }).n,
    models: (d.prepare("SELECT COUNT(*) AS n FROM trimble_models").get() as { n: number }).n,
    libraries: (d.prepare("SELECT COUNT(*) AS n FROM trimble_libraries").get() as { n: number }).n,
    model_libraries: (d.prepare("SELECT COUNT(*) AS n FROM trimble_model_libraries").get() as { n: number }).n,
    cache_entries: (d.prepare("SELECT COUNT(*) AS n FROM trimble_cache").get() as { n: number }).n,
  };
  const stamps: string[] = [];
  for (const sql of [
    "SELECT MAX(fetched_at) AS t FROM trimble_projects",
    "SELECT MAX(fetched_at) AS t FROM trimble_models",
    "SELECT MAX(fetched_at) AS t FROM trimble_libraries",
    "SELECT MAX(fetched_at) AS t FROM trimble_cache",
  ]) {
    const t = (d.prepare(sql).get() as { t: string | null }).t;
    if (t) stamps.push(t);
  }
  return { ...counts, last_refreshed_at: stamps.sort().at(-1) ?? null };
}
