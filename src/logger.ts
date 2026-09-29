import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
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
};
