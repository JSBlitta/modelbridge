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
  ensureEventsTable();
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
    db()
      .prepare("INSERT INTO events (ts, category, level, summary, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), input.category, input.level ?? "info", input.summary, input.detail ?? null);
    // Keep the table bounded — retain the most recent events only
    db().prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)").run(MAX_EVENTS);
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
  return db()
    .prepare(`SELECT * FROM events${where} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as EventRow[];
}

export function clearEvents(category?: string): void {
  ensureEventsTable();
  if (category) db().prepare("DELETE FROM events WHERE category = ?").run(category);
  else db().prepare("DELETE FROM events").run();
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
  db()
    .prepare("INSERT OR REPLACE INTO column_presets (name, mapping) VALUES (?, ?)")
    .run(name, JSON.stringify(mapping));
}

export function getPresets(): { id: number; name: string; mapping: Record<string, string> }[] {
  const rows = db().prepare("SELECT * FROM column_presets").all() as Record<string, unknown>[];
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
  db()
    .prepare(`INSERT INTO sessions (id, username, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, username, email, row.created_at, row.expires_at);
  return row;
}

export function getSession(id: string): SessionRow | null {
  const row = db().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  return row;
}

export function deleteSession(id: string): void {
  db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function pruneExpiredSessions(): void {
  db().prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
}

// --- Settings (key/value, admin-editable) ---

export function getAllSettings(): Record<string, string> {
  const rows = db().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
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
  return db().prepare("SELECT * FROM reporting_schedule ORDER BY position, id").all() as ReportingScheduleRow[];
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
  db().prepare("DELETE FROM reporting_schedule WHERE id = ?").run(id);
}
