import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.ts";

// debug: every incoming route and every outgoing API call (method, url, status, ms).
// trace: debug plus the request and response bodies of those API calls.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 } as const;
type Level = keyof typeof LEVELS;

let _level: number = LEVELS.info;
let _logFile: string | null = null;
let _stream: WriteStream | null = null;

// Configure level ("error" | "warn" | "info" | "debug", default "info") and an
// optional log file. When LOG_FILE is set, every message is also appended to
// that file (timestamped) in addition to the console.
export function initLogger(level?: string, logFile?: string): void {
  const lvl = (level || process.env.LOG_LEVEL || "info").trim().toLowerCase();
  // An unrecognised value used to leave the level at info without a word, so
  // LOG_LEVEL="debug" (quoted) or a typo looked like "debug logs nothing".
  if (lvl in LEVELS) _level = LEVELS[lvl as Level];
  else console.warn(`[logger] LOG_LEVEL "${lvl}" is not one of ${Object.keys(LEVELS).join("|")}; using info`);
  const name = (Object.keys(LEVELS) as Level[]).find((k) => LEVELS[k] === _level);
  console.info(`[logger] level=${name}${logFile || process.env.LOG_FILE ? ` file=${logFile || process.env.LOG_FILE}` : ""}`);

  _logFile = logFile || process.env.LOG_FILE || "";
  if (_stream) { _stream.end(); _stream = null; }
  if (_logFile) {
    try {
      const dir = dirname(_logFile);
      if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    } catch { /* ignore — logging must never crash the app */ }
  }
  logOutgoingCalls();
}

// --- Outgoing API calls ------------------------------------------------------
//
// Produuzit, Trimble, SharePoint and the reporting client all call the global
// fetch (18 call sites), so wrapping it once logs every one of them, including
// any added later. The level is checked per call, so this costs nothing at info.

const SECRET_KEY = /token|secret|password|authorization|^(code|key|access|refresh|api_key)$/i;
// Credential exchanges (matched on the path, not the query, so Trimble's
// `skiptoken` cursor does not count): never log their bodies, even at trace.
const CREDENTIAL_PATH = /token|oauth|login/i;
const BODY_LIMIT = 2000;

function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return raw;
  }
}

function redactBody(body: string): string {
  let out = body;
  try {
    out = JSON.stringify(JSON.parse(body), (k, v) => (k && SECRET_KEY.test(k) && typeof v !== "object" ? "***" : v));
  } catch { /* not JSON: log as is */ }
  return out.length > BODY_LIMIT ? `${out.slice(0, BODY_LIMIT)}… (${out.length} chars)` : out;
}

let _fetchWrapped = false;

function logOutgoingCalls(): void {
  if (_fetchWrapped) return;
  _fetchWrapped = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (_level < LEVELS.debug) return realFetch(input, init);
    const url = redactUrl(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let path = url;
    try { path = new URL(url).pathname; } catch { /* keep the whole string */ }
    const bodies = _level >= LEVELS.trace && !CREDENTIAL_PATH.test(path);
    if (bodies && typeof init?.body === "string") write("trace", [`[api] ${method} ${url} body: ${redactBody(init.body)}`]);
    const started = Date.now();
    try {
      const res = await realFetch(input, init);
      write("debug", [`[api] ${method} ${url} -> ${res.status} ${Date.now() - started}ms`]);
      if (bodies) {
        // clone() so the caller still gets an unread body.
        res.clone().text().then(
          (t) => write("trace", [`[api] ${method} ${url} response: ${redactBody(t)}`]),
          () => { /* body unreadable: nothing to log */ },
        );
      }
      return res;
    } catch (e) {
      write("debug", [`[api] ${method} ${url} failed after ${Date.now() - started}ms: ${e instanceof Error ? e.message : String(e)}`]);
      throw e;
    }
  };
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function write(level: Level, args: unknown[]): void {
  if (_level < LEVELS[level]) return;

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${args.map(formatArg).join(" ")}`;

  // Console output (gated by level)
  const consoleFn =
    level === "error" ? console.error
    : level === "warn" ? console.warn
    : level === "info" ? console.info
    : console.debug;
  // The formatted line, not the raw args: otherwise the console showed no
  // timestamp and no level, and a debug line was indistinguishable from info.
  consoleFn(line);

  // File output (not gated — the level check above already applies). A buffered
  // stream avoids blocking the event loop on every logged request.
  if (_logFile) {
    try {
      if (!_stream) {
        _stream = createWriteStream(_logFile, { flags: "a" });
        _stream.on("error", () => { /* logging must never crash the app */ });
      }
      _stream.write(line + "\n");
    } catch { /* ignore */ }
  }
}

export const logger = {
  error: (...args: unknown[]) => write("error", args),
  warn: (...args: unknown[]) => write("warn", args),
  info: (...args: unknown[]) => write("info", args),
  debug: (...args: unknown[]) => write("debug", args),
  trace: (...args: unknown[]) => write("trace", args),
};

// Configure on load, not from index.ts: ESM runs every import first, and some
// of them log (db.ts reports the file it opens), which used to happen at the
// default level and outside LOG_FILE.
initLogger(env.LOG_LEVEL, env.LOG_FILE);
