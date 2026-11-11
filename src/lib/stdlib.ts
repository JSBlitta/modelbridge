// Standard libraries: how a CSV cell names them, how a name or uuid resolves,
// and which designs they hold.
import { fetchAllPages } from "../produuzit-client.ts";
import { logger } from "../logger.ts";
import { isUuid } from "./validate.ts";
import { parseStdlibCell } from "../csv-parser.ts";

// uuid, name or project number -> stdlib uuid. A uuid is taken as given, listed or
// not, so a library the list endpoint does not return can still be linked.
export async function loadStdlibResolver(): Promise<(value: string) => string | undefined> {
  let libs: Record<string, unknown>[] = [];
  try {
    libs = (await fetchAllPages("/company/standard_libraries/")) as Record<string, unknown>[];
  } catch (e) {
    logger.warn("[stdlib] /company/standard_libraries/ failed, trying projects?standard_library=true:", e);
    try {
      libs = (await fetchAllPages("/company/projects/", { standard_library: true })) as Record<string, unknown>[];
    } catch (e2) {
      logger.warn("[stdlib] could not list standard libraries; only uuids resolve:", e2);
    }
  }
  const byKey = new Map<string, string>();
  for (const l of libs) {
    const uuid = String(l.uuid ?? "");
    if (!uuid) continue;
    for (const k of [uuid, l.name, l.project_number]) {
      const key = String(k ?? "").trim().toLowerCase();
      if (key && !byKey.has(key)) byKey.set(key, uuid);
    }
  }
  return (value: string) => {
    const v = value.trim();
    return byKey.get(v.toLowerCase()) ?? (isUuid(v) ? v.toLowerCase() : undefined);
  };
}

// Resolve cell values to uuids; the ones that do not resolve are returned too, so
// the caller can report them instead of silently dropping a link.
export function resolveStdlibs(values: string[], resolve: (v: string) => string | undefined) {
  const uuids: string[] = [];
  const unresolved: string[] = [];
  for (const v of values.flatMap(parseStdlibCell)) {
    const u = resolve(v);
    if (u) { if (!uuids.includes(u)) uuids.push(u); } else unresolved.push(v);
  }
  return { uuids, unresolved };
}

// Design name -> uuid per standard library, each library fetched once.
export function stdlibDesigns() {
  const cache = new Map<string, Promise<Map<string, string>>>();
  const designsOf = (stdlibUuid: string) => {
    let p = cache.get(stdlibUuid);
    if (!p) {
      p = (fetchAllPages("/constructibles/assembly_designs/", { project: stdlibUuid }) as Promise<Record<string, unknown>[]>)
        .then((all) => new Map(all.map((d) => [String(d.name), String(d.uuid)])))
        .catch((e) => { logger.warn(`[stdlib] designs of ${stdlibUuid} not loaded:`, e); return new Map<string, string>(); });
      cache.set(stdlibUuid, p);
    }
    return p;
  };
  // First library (in the given order) that holds the design.
  return async (designName: string, stdlibUuids: string[]) => {
    for (const s of stdlibUuids) {
      const uuid = (await designsOf(s)).get(designName);
      if (uuid) return { uuid, stdlib: s };
    }
    return null;
  };
}
