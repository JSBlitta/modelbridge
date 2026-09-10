// Trimble-defined property sets.
//
// Trimble Connect lets users define property sets *inside Trimble* and attach
// them to model entities. Those values never reach the IFC, so the Model API
// cannot see them. Two further APIs hold them:
//
//   Organizer     which property-set libraries is this project bound to?
//   Property Set  the definitions (schema) and the values (per entity)
//
// Ported from the Power BI connector in _attic/powerbi-connector; the mechanics
// are written up in docs/TrimblePropertysets.md.
//
// The end goal is that a Trimble-defined property is indistinguishable from an
// IFC-native one downstream: mergeTrimblePsets folds them into the same
// `entity.psets` object that transformEntityPsets already produces, so the
// column mapper, extractProp and every import path work unchanged.

import { fetchAllTrimblePages, getRegionEndpoints, trimbleGet } from "./trimble-client.js";
import { indexByFrnCandidates, parseFrn } from "./trimble-frn.js";
import { logger } from "./logger.js";

// --- Shapes returned by the Property Set API -------------------------------

interface PsetDefResponse {
  id: string;
  libId: string;
  v?: number;
  i18n?: Record<string, { name?: string; props?: Record<string, string> }>;
  schema?: { props?: Record<string, { type?: string; description?: string; enum?: unknown }> };
}

interface PsetValueResponse {
  link?: string;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One property, resolved from an opaque id to a display name. */
export interface PsetPropertyDef {
  libId: string;
  defId: string;
  /** Name of the property set this property belongs to. */
  psetName: string;
  /** The opaque key used in the values payload. */
  propId: string;
  /** Human-readable name from the i18n block, disambiguated if needed. */
  propName: string;
  propType: string;
}

export interface TrimblePsetMergeResult {
  /** Entities, with Trimble property sets folded into `psets`. */
  entities: Record<string, unknown>[];
  diagnostics: TrimblePsetDiagnostics;
}

export interface TrimblePsetDiagnostics {
  libraryCount: number;
  definitionCount: number;
  propertyCount: number;
  psetValueCount: number;
  /** Entities that received at least one Trimble property set. */
  matchedEntities: number;
  /** Property-set values whose link matched no entity in the model. */
  unmatchedValues: number;
  /** Sample keys from each side, populated only when nothing matched. */
  sampleEntityKeys: string[];
  sampleLinkKeys: string[];
  notes: string[];
}

// --- 1. Discovery ----------------------------------------------------------

/**
 * Which property-set libraries is this project bound to?
 *
 * The Organizer models a project as a forest of trees of nodes; Trimble keeps
 * the bindings at the well-known path ProjectContext -> PSetLibs.
 *
 * A 404 means "this project has no libraries", not a failure — the connector
 * treats it the same way (Organizer.pqm:15) and disables the feature.
 */
export async function getProjectLibraryIds(projectId: string): Promise<string[]> {
  const endpoints = getRegionEndpoints();
  const url = joinUrl(
    endpoints.Organizer,
    `forests/project:${encodeURIComponent(projectId)}:data/trees/ProjectContext/nodes/PSetLibs`,
  );

  let node: { links?: string[] } | null = null;
  try {
    node = (await trimbleGet(url)) as { links?: string[] };
  } catch (e) {
    // 404 is the normal "no libraries" answer; anything else is worth a note
    // but still must not break the IFC import path.
    logger.debug(`[trimble-psets] no PSetLibs node for project ${projectId}: ${String(e)}`);
    return [];
  }

  const links = Array.isArray(node?.links) ? node.links : [];
  return links.map((link) => parseFrn(link).id).filter(Boolean);
}

// --- 2. Definitions --------------------------------------------------------

/**
 * Fetch every property definition across the given libraries.
 *
 * The structural quirk that makes this necessary: `schema.props` is keyed by an
 * opaque property id, and the human-readable name lives in a parallel
 * `i18n["en-US"].props` record keyed the same way. The values payload uses the
 * same opaque ids, so without the definitions there is no way to name a column.
 */
export async function getPsetDefinitions(libIds: string[]): Promise<PsetPropertyDef[]> {
  const endpoints = getRegionEndpoints();
  const defs: PsetPropertyDef[] = [];

  for (const libId of libIds) {
    const url = joinUrl(endpoints.Propertyset, `libs/${encodeURIComponent(libId)}/defs`);
    let items: PsetDefResponse[] = [];
    try {
      items = (await fetchAllTrimblePages(url, 200)) as PsetDefResponse[];
    } catch (e) {
      logger.warn(`[trimble-psets] could not read definitions for library ${libId}: ${String(e)}`);
      continue;
    }

    for (const item of items) {
      const en = item.i18n?.["en-US"] ?? {};
      const psetName = en.name ?? item.id;
      const schemaProps = item.schema?.props ?? {};
      const nameByPropId = en.props ?? {};

      for (const propId of Object.keys(schemaProps)) {
        defs.push({
          libId: item.libId ?? libId,
          defId: item.id,
          psetName,
          propId,
          propName: nameByPropId[propId] || propId,
          propType: schemaProps[propId]?.type ?? "",
        });
      }
    }
  }

  return disambiguate(defs);
}

/**
 * Two property sets may use the same display name for different properties.
 * The connector appends the property-set name in that case
 * (Propertyset.pqm:103-134); same rule here, applied once over the whole set.
 */
function disambiguate(defs: PsetPropertyDef[]): PsetPropertyDef[] {
  const countByName = new Map<string, number>();
  for (const d of defs) countByName.set(d.propName, (countByName.get(d.propName) ?? 0) + 1);

  return defs.map((d) =>
    (countByName.get(d.propName) ?? 0) > 1
      ? { ...d, propName: `${d.propName}_${d.psetName}` }
      : d,
  );
}

// --- 3. Values -------------------------------------------------------------

interface PsetValueRow {
  /** The FRN of the entity this property set is attached to. */
  link: string;
  psetName: string;
  /** Display name -> value, already resolved from opaque property ids. */
  values: Record<string, unknown>;
}

export async function getPsetValues(defs: PsetPropertyDef[]): Promise<PsetValueRow[]> {
  const endpoints = getRegionEndpoints();

  // One call per (libId, defId); a definition contributes many properties.
  const pairs = new Map<string, { libId: string; defId: string; psetName: string }>();
  for (const d of defs) {
    pairs.set(`${d.libId}|${d.defId}`, { libId: d.libId, defId: d.defId, psetName: d.psetName });
  }

  const nameByDefAndProp = new Map<string, string>();
  for (const d of defs) nameByDefAndProp.set(`${d.defId}|${d.propId}`, d.propName);

  const rows: PsetValueRow[] = [];
  for (const { libId, defId, psetName } of pairs.values()) {
    const url = joinUrl(
      endpoints.Propertyset,
      `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(defId)}/psets`,
    );
    let items: PsetValueResponse[] = [];
    try {
      items = (await fetchAllTrimblePages(url, 200)) as PsetValueResponse[];
    } catch (e) {
      logger.warn(`[trimble-psets] could not read values for def ${defId}: ${String(e)}`);
      continue;
    }

    for (const item of items) {
      if (!item.link) continue;
      const values: Record<string, unknown> = {};
      for (const [propId, value] of Object.entries(item.props ?? {})) {
        if (value === null || value === undefined || value === "") continue;
        values[nameByDefAndProp.get(`${defId}|${propId}`) ?? propId] = value;
      }
      if (Object.keys(values).length) rows.push({ link: item.link, psetName, values });
    }
  }

  return rows;
}

// --- 4. The merge ----------------------------------------------------------

/**
 * Fold Trimble-defined property sets into the entities' own `psets` object.
 *
 * The connector does this as a left outer join of model entity `id` against the
 * prefix-stripped pset `link` (Helpers.pqm:191). We do the same, except the
 * link is matched against every plausible reading of its FRN — see
 * trimble-frn.ts for why that is not over-engineering — and a total miss is
 * reported rather than quietly producing empty columns.
 */
export function mergeTrimblePsets(
  entities: Record<string, unknown>[],
  values: PsetValueRow[],
  diagnosticsSeed: Partial<TrimblePsetDiagnostics> = {},
): TrimblePsetMergeResult {
  const byCandidate = indexByFrnCandidates(values, (v) => v.link);

  // Group by entity so one entity can carry several property sets.
  const rowsForEntity = new Map<string, PsetValueRow[]>();
  for (const row of values) {
    for (const key of parseFrn(row.link).candidates) {
      if (!rowsForEntity.has(key)) rowsForEntity.set(key, []);
      rowsForEntity.get(key)!.push(row);
    }
  }

  let matchedEntities = 0;
  const matchedLinks = new Set<string>();

  const merged = entities.map((entity) => {
    const entityId = String(entity.id ?? "");
    if (!entityId) return entity;

    const rows = rowsForEntity.get(entityId);
    if (!rows?.length) return entity;

    matchedEntities++;
    const psets = { ...((entity.psets as Record<string, unknown>) ?? {}) };
    for (const row of rows) {
      matchedLinks.add(row.link);
      // Merge rather than replace: an IFC-native set of the same name keeps its
      // properties and gains the Trimble-defined ones.
      psets[row.psetName] = { ...((psets[row.psetName] as Record<string, unknown>) ?? {}), ...row.values };
    }
    return { ...entity, psets };
  });

  const notes: string[] = [];
  const unmatchedValues = values.filter((v) => !matchedLinks.has(v.link)).length;

  // The failure this guards against: the FRN grammar differing from what we
  // assumed, which as a silent left outer join looks exactly like "this project
  // has no Trimble properties".
  if (values.length > 0 && matchedEntities === 0) {
    notes.push(
      `${values.length} Trimble property-set value(s) were found but none matched a model entity. ` +
      `This usually means the entity reference format differs from what was expected — ` +
      `compare the sample keys below.`,
    );
  }

  const diagnostics: TrimblePsetDiagnostics = {
    libraryCount: diagnosticsSeed.libraryCount ?? 0,
    definitionCount: diagnosticsSeed.definitionCount ?? 0,
    propertyCount: diagnosticsSeed.propertyCount ?? 0,
    psetValueCount: values.length,
    matchedEntities,
    unmatchedValues,
    sampleEntityKeys:
      matchedEntities === 0 ? entities.slice(0, 3).map((e) => String(e.id ?? "")) : [],
    sampleLinkKeys:
      matchedEntities === 0 ? values.slice(0, 3).map((v) => `${v.link} -> ${parseFrn(v.link).id}`) : [],
    notes,
  };

  return { entities: merged, diagnostics };
}

// --- Orchestration ---------------------------------------------------------

/**
 * The whole pipeline for one project. Returns the entities unchanged when the
 * project has no property-set libraries, which is the common case.
 */
export async function applyTrimblePropertySets(
  projectId: string,
  entities: Record<string, unknown>[],
): Promise<TrimblePsetMergeResult> {
  const empty: TrimblePsetDiagnostics = {
    libraryCount: 0, definitionCount: 0, propertyCount: 0, psetValueCount: 0,
    matchedEntities: 0, unmatchedValues: 0, sampleEntityKeys: [], sampleLinkKeys: [], notes: [],
  };

  const libIds = await getProjectLibraryIds(projectId);
  if (!libIds.length) return { entities, diagnostics: empty };

  const defs = await getPsetDefinitions(libIds);
  if (!defs.length) {
    return { entities, diagnostics: { ...empty, libraryCount: libIds.length } };
  }

  const values = await getPsetValues(defs);
  const distinctDefs = new Set(defs.map((d) => d.defId)).size;

  const result = mergeTrimblePsets(entities, values, {
    libraryCount: libIds.length,
    definitionCount: distinctDefs,
    propertyCount: defs.length,
  });

  logger.info(
    `[trimble-psets] project=${projectId} libraries=${libIds.length} defs=${distinctDefs} ` +
    `properties=${defs.length} values=${values.length} matched=${result.diagnostics.matchedEntities}`,
  );
  for (const note of result.diagnostics.notes) logger.warn(`[trimble-psets] ${note}`);

  return result;
}

/** Join a base that may or may not end in "/" with a path that does not start with one. */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
