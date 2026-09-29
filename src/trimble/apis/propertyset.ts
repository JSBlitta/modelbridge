import type { HttpClient } from '../http/client.js';
import type { RegionEndpoints } from '../types/index.js';
import { Pagination } from '../http/pagination.js';
import { NotFoundError } from '../http/errors.js';

export interface PsetLibDef {
  version: number;
  libId: string;
  defId: string;
  PSetName: string;
  PropId: string;
  prop_name: string;
  prop_type: string;
  Description: string;
  Enum: string;
}

export interface PsetInstance {
  link: string;
  libId: string;
  defId: string;
  v: number;
  schemaV: number;
  props: Record<string, unknown>;
}

export interface TrimblePsetRow {
  link: string;
  [propName: string]: unknown;
}

export interface PsetDefRef {
  libId: string;
  defId: string;
}

interface PsetInstanceRef extends PsetDefRef {
  link: string;
}

interface RawDefLocale {
  name?: string;
  props?: Record<string, string>;
}

interface RawLibDefItem {
  v: number;
  libId: string;
  id: string;
  name?: string;
  i18n?: Record<string, RawDefLocale>;
  schema: { props: Record<string, { type: string; description?: string; enum?: string | string[] }> };
}

interface PsetBatchGetError<T> {
  item: T;
  code: string;
  message: string;
}

interface PsetBatchGetResponse {
  unprocessed?: { defs?: PsetDefRef[]; psets?: PsetInstanceRef[] };
  responses?: { defs?: RawLibDefItem[]; psets?: PsetInstance[] };
  errors?: { defs?: Array<PsetBatchGetError<PsetDefRef>>; psets?: Array<PsetBatchGetError<PsetInstanceRef>> };
}

export interface PropertysetApi {
  getPSetLibDefs(_projectId: string, libIds: string[]): Promise<PsetLibDef[]>;
  batchGetDefinitions(defRefs: PsetDefRef[]): Promise<PsetLibDef[]>;
  getTrimblePsets(_projectId: string, psetDefs: PsetLibDef[]): Promise<TrimblePsetRow[]>;
  getTrimbleData(projectId: string, libIds: string[]): Promise<TrimblePsetRow[]>;
  getPsetsByLink(link: string): Promise<PsetInstance[]>;
  getPsetsForEntities(
    entityGuids: string[],
    options?: { concurrency?: number; libIds?: string[] },
  ): Promise<TrimblePsetRow[]>;
}

const BATCH_GET_CHUNK_SIZE = 100;
const BATCH_GET_MAX_ATTEMPTS = 3;
const PSET_BATCH_CHUNK_SIZE = 100; // pset batch-get rejects more than 100 items
const PSET_BATCH_CONCURRENCY = 6;

export function createPropertysetApi(client: HttpClient, endpoints: RegionEndpoints): PropertysetApi {
  const pagination = new Pagination(client);

  const api: PropertysetApi = {
    async getPSetLibDefs(_projectId: string, libIds: string[]): Promise<PsetLibDef[]> {
      const items: RawLibDefItem[] = [];

      for (const libId of libIds) {
        const url = `${endpoints.Propertyset}libs/${encodeURIComponent(libId)}/defs`;

        try {
          items.push(...(await pagination.fetchAllPages<RawLibDefItem>(url, 200)));
        } catch (error) {
          if (error instanceof NotFoundError) {
            console.warn(`Propertyset library not found, skipping: ${libId}`);
            continue;
          }
          throw error;
        }
      }

      return flattenDefinitions(items);
    },

    async batchGetDefinitions(defRefs: PsetDefRef[]): Promise<PsetLibDef[]> {
      const seen = new Set<string>();
      const uniqueRefs = defRefs.filter((ref) => {
        const key = `${ref.libId}|${ref.defId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const collected: RawLibDefItem[] = [];

      for (let i = 0; i < uniqueRefs.length; i += BATCH_GET_CHUNK_SIZE) {
        let pending = uniqueRefs.slice(i, i + BATCH_GET_CHUNK_SIZE);

        for (let attempt = 0; attempt < BATCH_GET_MAX_ATTEMPTS && pending.length > 0; attempt++) {
          const response = await client.post<PsetBatchGetResponse>(
            `${endpoints.Propertyset}batch-get`,
            { defs: pending },
          );
          collected.push(...(response.responses?.defs ?? []));
          for (const error of response.errors?.defs ?? []) {
            console.warn(
              `PSet definition fetch failed for ${error.item.libId}/${error.item.defId}: ${error.code} ${error.message}`,
            );
          }
          pending = response.unprocessed?.defs ?? [];
        }

        if (pending.length > 0) {
          console.warn(`PSet batch-get left ${pending.length} definitions unprocessed`);
        }
      }

      return flattenDefinitions(collected);
    },

    async getTrimblePsets(_projectId: string, psetDefs: PsetLibDef[]): Promise<TrimblePsetRow[]> {
      const seenPairs = new Set<string>();
      const tables: Array<Record<string, unknown>[]> = [];

      for (const def of psetDefs) {
        const pairKey = `${def.libId}|${def.defId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const url = `${endpoints.Propertyset}libs/${encodeURIComponent(def.libId)}/defs/${encodeURIComponent(def.defId)}/psets`;
        const items = await pagination.fetchAllPages<Record<string, unknown>>(url, 200);

        // Rename PropIds within this lib/def pair so identical PropIds in
        // different definitions cannot collide.
        const pairRename = new Map<string, string>();
        for (const pairDef of psetDefs) {
          if (pairDef.libId === def.libId && pairDef.defId === def.defId) {
            pairRename.set(pairDef.PropId, normalizeName(pairDef.prop_name));
          }
        }

        const expanded = items.map((item) => {
          const props = (item.props ?? {}) as Record<string, unknown>;
          const row: Record<string, unknown> = { Link: removeFrnPrefix(String(item.link ?? '')) };
          for (const [key, value] of Object.entries(props)) {
            row[pairRename.get(key) ?? normalizeName(key)] = value;
          }
          return row;
        });

        tables.push(expanded);
      }

      if (tables.length === 0) {
        return [];
      }

      // Collapse to one row per entity
      const grouped = new Map<string, Record<string, unknown>>();
      for (const row of tables.flat()) {
        const link = String(row.Link ?? '');
        if (!grouped.has(link)) {
          grouped.set(link, { Link: link });
        }
        const existing = grouped.get(link)!;
        for (const [key, value] of Object.entries(row)) {
          if (key === 'Link') continue;
          if (existing[key] === null || existing[key] === undefined) {
            existing[key] = value;
          }
        }
      }

      return Array.from(grouped.values()) as TrimblePsetRow[];
    },

    async getTrimbleData(projectId: string, libIds: string[]): Promise<TrimblePsetRow[]> {
      const defs = await api.getPSetLibDefs(projectId, libIds);
      return api.getTrimblePsets(projectId, defs);
    },

    async getPsetsByLink(link: string): Promise<PsetInstance[]> {
      const url = `${endpoints.Propertyset}psets/${encodeURIComponent(link)}`;
      return pagination.fetchAllPages<PsetInstance>(url, 500);
    },

    async getPsetsForEntities(
      entityGuids: string[],
      options: { concurrency?: number; libIds?: string[] } = {},
    ): Promise<TrimblePsetRow[]> {
      let defs: PsetLibDef[];
      let allInstances: PsetInstance[];

      if (options.libIds && options.libIds.length > 0) {
        ({ defs, instances: allInstances } = await fetchInstancesByDefinition(entityGuids, options.libIds));
      } else {
        ({ defs, instances: allInstances } = await fetchInstancesByLink(entityGuids, options.concurrency ?? 5));
      }

      if (allInstances.length === 0) {
        return [];
      }

      const renameMap = new Map<string, string>();
      for (const def of defs) {
        renameMap.set(`${def.libId}|${def.defId}|${def.PropId}`, normalizeName(def.prop_name));
      }

      const grouped = new Map<string, Record<string, unknown>>();
      for (const instance of allInstances) {
        const guid = removeFrnPrefix(instance.link);
        if (!grouped.has(guid)) {
          grouped.set(guid, { Link: guid });
        }
        const row = grouped.get(guid)!;
        for (const [propId, value] of Object.entries(instance.props)) {
          const key = renameMap.get(`${instance.libId}|${instance.defId}|${propId}`) ?? normalizeName(propId);
          if (!(key in row) || row[key] === null || row[key] === undefined) {
            row[key] = value;
          }
        }
      }

      return Array.from(grouped.values()) as TrimblePsetRow[];
    },
  };

  // Fast path: with the project libraries known, list their definitions once and
  // batch-get psets per definition for all entity links, instead of one
  // GET /psets/{link} per entity.
  async function fetchInstancesByDefinition(
    entityGuids: string[],
    libIds: string[],
  ): Promise<{ defs: PsetLibDef[]; instances: PsetInstance[] }> {
    const defs = await api.getPSetLibDefs('', libIds);

    const seenPairs = new Set<string>();
    const pairs: PsetDefRef[] = [];
    for (const def of defs) {
      const key = `${def.libId}|${def.defId}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      pairs.push({ libId: def.libId, defId: def.defId });
    }

    console.log(
      `Fetching Trimble psets for ${entityGuids.length} entities across ${pairs.length} definitions (batch-get)...`,
    );

    const chunks: PsetInstanceRef[][] = [];
    for (const pair of pairs) {
      const refs: PsetInstanceRef[] = entityGuids.map((guid) => ({
        link: `frn:entity:${guid}`,
        libId: pair.libId,
        defId: pair.defId,
      }));
      for (let i = 0; i < refs.length; i += PSET_BATCH_CHUNK_SIZE) {
        chunks.push(refs.slice(i, i + PSET_BATCH_CHUNK_SIZE));
      }
    }

    const instances: PsetInstance[] = [];
    let missingCombos = 0;
    let chunksDone = 0;

    const fetchChunk = async (initial: PsetInstanceRef[]): Promise<void> => {
      let pending = initial;

      for (let attempt = 0; attempt < BATCH_GET_MAX_ATTEMPTS && pending.length > 0; attempt++) {
        const response = await client.post<PsetBatchGetResponse>(`${endpoints.Propertyset}batch-get`, {
          psets: pending,
        });
        instances.push(...(response.responses?.psets ?? []));
        // Most entity/definition combinations have no pset; per-item errors are expected.
        missingCombos += response.errors?.psets?.length ?? 0;
        pending = response.unprocessed?.psets ?? [];
      }

      if (pending.length > 0) {
        console.warn(`PSet batch-get left ${pending.length} psets unprocessed`);
      }

      chunksDone++;
      if (chunksDone % 25 === 0 || chunksDone === chunks.length) {
        console.log(`  batches: ${chunksDone}/${chunks.length}, ${instances.length} instances so far`);
      }
    };

    let nextChunk = 0;
    const workers = Array.from({ length: Math.min(PSET_BATCH_CONCURRENCY, chunks.length) }, async () => {
      while (nextChunk < chunks.length) {
        await fetchChunk(chunks[nextChunk++]!);
      }
    });
    await Promise.all(workers);

    if (missingCombos > 0) {
      console.log(`  (${missingCombos} entity/definition combinations had no pset)`);
    }

    return { defs, instances };
  }

  // Fallback: discover psets per entity link, then batch-get only the
  // definitions that actually occurred.
  async function fetchInstancesByLink(
    entityGuids: string[],
    concurrency: number,
  ): Promise<{ defs: PsetLibDef[]; instances: PsetInstance[] }> {
    console.log(`Fetching Trimble psets per entity (${entityGuids.length} entities, concurrency ${concurrency})...`);

    const instances: PsetInstance[] = [];
    let processed = 0;

    for (let i = 0; i < entityGuids.length; i += concurrency) {
      const batch = entityGuids.slice(i, i + concurrency);
      const results = await Promise.all(batch.map((guid) => api.getPsetsByLink(`frn:entity:${guid}`)));
      for (const entityInstances of results) {
        instances.push(...entityInstances);
      }
      processed += batch.length;
      if (processed % 50 < concurrency || processed === entityGuids.length) {
        console.log(`  entities: ${processed}/${entityGuids.length}`);
      }
    }

    if (instances.length === 0) {
      return { defs: [], instances };
    }

    const defRefs = instances.map((instance) => ({ libId: instance.libId, defId: instance.defId }));
    const defs = await api.batchGetDefinitions(defRefs);

    return { defs, instances };
  }

  return api;
}

function flattenDefinitions(items: RawLibDefItem[]): PsetLibDef[] {
  const allDefs: PsetLibDef[] = [];

  for (const item of items) {
    const locale = pickLocale(item.i18n);
    const psetName = locale?.name ?? item.name ?? item.id;
    const schemaProps = item.schema.props;
    const localeProps = locale?.props ?? {};
    const propKeys = Object.keys(schemaProps);

    const duplicateNames = new Set<string>();
    const nameCounts = new Map<string, number>();
    for (const key of propKeys) {
      const rawName = localeProps[key] ?? key;
      nameCounts.set(rawName, (nameCounts.get(rawName) ?? 0) + 1);
    }
    for (const [name, count] of nameCounts) {
      if (count > 1) duplicateNames.add(name);
    }

    for (const key of propKeys) {
      const rawName = localeProps[key] ?? key;
      const propName = duplicateNames.has(rawName) ? `${rawName}_${psetName}` : rawName;
      const propDetails = schemaProps[key];

      allDefs.push({
        version: item.v,
        libId: item.libId,
        defId: item.id,
        PSetName: psetName,
        PropId: key,
        prop_name: propName,
        prop_type: propDetails.type,
        Description: propDetails.description ?? '',
        Enum: formatEnum(propDetails.enum),
      });
    }
  }

  // Cross-library duplicate handling: suffix with PSetName when the same prop_name appears in multiple psets
  const nameToPsetNames = new Map<string, Set<string>>();
  for (const def of allDefs) {
    const set = nameToPsetNames.get(def.prop_name) ?? new Set<string>();
    set.add(def.PSetName);
    nameToPsetNames.set(def.prop_name, set);
  }

  return allDefs.map((def) => {
    const psetNames = nameToPsetNames.get(def.prop_name);
    if (psetNames && psetNames.size > 1) {
      return { ...def, prop_name: `${def.prop_name}_${def.PSetName}` };
    }
    return def;
  });
}

function pickLocale(i18n: Record<string, RawDefLocale> | undefined): RawDefLocale | undefined {
  if (!i18n) return undefined;
  if (i18n['en-US']) return i18n['en-US'];
  for (const [key, locale] of Object.entries(i18n)) {
    if (!key.startsWith('__')) return locale;
  }
  return undefined;
}

function formatEnum(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(';');
  return value ?? '';
}

function removeFrnPrefix(inputText: string): string {
  if (!inputText.startsWith('frn:')) return inputText;
  const decoded = decodeURIComponent(inputText);
  const parts = decoded.split(':');
  // Resource ids may themselves contain ':' segments (e.g. frn:lib:{libId}:{projectId}:{uuid})
  return parts.length >= 3 ? parts.slice(2).join(':') : inputText;
}

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/^-+/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
