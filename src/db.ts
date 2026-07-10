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
}

export function upsertBatch(
  uuid: string,
  name: string,
  projectUuid: string,
  phase: string,
  linkedStdlibs?: string[] | null,
  state = "provisional",
): void {
  const now = new Date().toISOString();
  const stdlibJson = linkedStdlibs ? JSON.stringify(linkedStdlibs) : null;
  db()
    .prepare(
      `INSERT INTO batches (uuid, name, project_uuid, phase, linked_stdlibs, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         name=excluded.name, project_uuid=excluded.project_uuid,
         phase=excluded.phase, linked_stdlibs=excluded.linked_stdlibs,
         state=excluded.state, updated_at=excluded.updated_at`,
    )
    .run(uuid, name, projectUuid, phase, stdlibJson, state, now, now);
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
