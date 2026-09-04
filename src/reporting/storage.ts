// Output storage for reporting results.
//
// Replaces the "Post in Sharepoint" flow (site "Produuzit-APIdata",
// folder "Shared Documents/API data/{Opslaglocatie}"). For now files are
// written locally; a SharePoint-backed OutputStore can be added later by
// implementing the same interface.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface WriteResult {
  path: string;        // absolute path of the file
  created: boolean;    // false when an existing file was left untouched
}

export interface OutputStore {
  write(relativeFolder: string, filename: string, content: string, overwrite: boolean): Promise<WriteResult>;
}

// Sanitize a SharePoint-style folder path ("Overview/Production") so it can
// never escape the root directory.
function sanitizeSegments(folder: string): string[] {
  return folder
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
}

export class LocalFileStore implements OutputStore {
  constructor(private readonly rootDir: string) {}

  async write(relativeFolder: string, filename: string, content: string, overwrite: boolean): Promise<WriteResult> {
    const dir = resolve(this.rootDir, ...sanitizeSegments(relativeFolder));
    mkdirSync(dir, { recursive: true });
    const full = join(dir, filename);

    // Non-overwrite mode: never clobber an existing file (SharePoint's
    // CreateFile would fail on a duplicate name — we skip gracefully).
    if (!overwrite && existsSync(full)) {
      return { path: full, created: false };
    }
    writeFileSync(full, content, "utf-8");
    return { path: full, created: true };
  }

  displayPath(absPath: string): string {
    try {
      return relative(process.cwd(), absPath);
    } catch {
      return absPath;
    }
  }
}

// Last-run bookkeeping. The original solution PATCHed the SharePoint list
// item's "Laatste run" column; locally we keep the same information in a JSON
// state file (a SharePoint-backed store can be added later).
export interface LastRunStore {
  get(endpoint: string): Promise<string | null>;
  set(endpoint: string, when: string): Promise<void>;
}

export class JsonLastRunStore implements LastRunStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Record<string, string>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  async get(endpoint: string): Promise<string | null> {
    return this.read()[endpoint] ?? null;
  }

  async set(endpoint: string, when: string): Promise<void> {
    const state = this.read();
    state[endpoint] = when;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2));
  }
}
