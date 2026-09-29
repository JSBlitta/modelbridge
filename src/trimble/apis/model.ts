import type { HttpClient } from '../http/client.js';
import type { RegionEndpoints } from '../types/index.js';
import { Pagination } from '../http/pagination.js';
import { ClientError } from '../http/errors.js';
import { mergeEntitiesWithIFCPSetDefs } from '../pipeline/entityMerger.js';
import { schemaTransformTable, generateSchema } from '../pipeline/schemaTransform.js';

export interface ModelEntity {
  id: string;
  psets?: ModelPset[];
  [key: string]: unknown;
}

export interface ModelPset {
  idx: number;
  pset_name: string;
  values: ModelPsetValue[];
}

export interface ModelPsetValue {
  prop_value: unknown;
  value_index: number;
}

export interface PsetDefinition {
  idx: number;
  name: string;
  pset_name: string;
  props: PsetPropDefinition[];
}

export interface PsetPropDefinition {
  prop_name: string;
  prop_type: string;
  def_index: number;
}

export interface IFCPSetDefs {
  defsList: PsetDefinition[];
  parsedDefs: SchemaColumn[];
}

export interface SchemaColumn {
  name: string;
  type: string;
}

export interface ModelFileRow {
  id: string;
  projectId: string;
  versionId?: string;
}

export interface ModelApi {
  getIdentifiers(modelId: string, versionId?: string): Promise<{ id: string }[]>;
  batchGet(modelId: string, identifiers: { id: string }[], versionId?: string, fields?: string): Promise<ModelEntity[]>;
  getModelData(row: ModelFileRow, fields?: string, filterString?: string): Promise<ModelEntity[]>;
  getIFCPSetDefs(modelId: string, versionId?: string): Promise<IFCPSetDefs>;
  ifcCollection(row: ModelFileRow): Promise<Record<string, unknown>[]>;
}

const DEFAULT_FIELDS = '&fields=id,product,psets,psets.name';

export function createModelApi(
  client: HttpClient,
  endpoints: RegionEndpoints,
  batchChunkSize = 5000,
): ModelApi {
  const pagination = new Pagination(client);

  return {
    async getIdentifiers(modelId: string, versionId?: string): Promise<{ id: string }[]> {
      const url = `${endpoints.Model}models/${encodeURIComponent(modelId)}/entities/`;
      const queryString = `fields=id${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ''}`;
      return pagination.fetchAllPages<{ id: string }>(url, 100000, queryString);
    },

    async batchGet(
      modelId: string,
      identifiers: { id: string }[],
      versionId?: string,
      fields = DEFAULT_FIELDS,
    ): Promise<ModelEntity[]> {
      const url = `${endpoints.Model}models/${encodeURIComponent(modelId)}/batch-get?${fields.replace(/^&/, '')}${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ''}`;
      const chunks = chunkArray(identifiers, batchChunkSize);

      const allEntities: ModelEntity[] = [];
      for (const chunk of chunks) {
        const response = await client.post<{ responses: { entities: ModelEntity[] } }>(url, {
          entities: chunk,
        });
        allEntities.push(...(response.responses?.entities ?? []));
      }
      return allEntities;
    },

    async getModelData(
      row: ModelFileRow,
      fields = DEFAULT_FIELDS,
      filterString?: string,
    ): Promise<ModelEntity[]> {
      const url = `${endpoints.Model}models/${encodeURIComponent(row.id)}/entities`;
      const queryString = `${fields.replace(/^&/, '')}${row.versionId ? `&versionId=${encodeURIComponent(row.versionId)}` : ''}${filterString ? `&${filterString.replace(/^&/, '')}` : ''}`;
      const raw = await pagination.fetchAllPages<ModelEntity>(url, 1000, queryString);
      return raw.map(indexEntity);
    },

    async getIFCPSetDefs(modelId: string, versionId?: string): Promise<IFCPSetDefs> {
      const url = `${endpoints.Model}models/${encodeURIComponent(modelId)}/psetdefs`;
      const queryString = (withVersion: boolean) =>
        withVersion && versionId ? `versionId=${encodeURIComponent(versionId)}` : undefined;

      let raw: Array<{
        idx: number;
        name: string;
        props: Array<{ name: string; type: string }>;
      }>;

      try {
        raw = await pagination.fetchAllPages(url, 30000, queryString(true));
      } catch (error) {
        if (versionId && error instanceof ClientError && error.status === 400) {
          console.warn(`getIFCPSetDefs failed with versionId=${versionId}, retrying without versionId`);
          raw = await pagination.fetchAllPages(url, 30000, queryString(false));
        } else {
          throw error;
        }
      }

      const flatProps = raw.flatMap((pset) =>
        (pset.props ?? []).map((prop) => ({
          pset_name: pset.name,
          nameNormalized: normalizeName(prop.name),
        })),
      );

      const nameCounts = new Map<string, Set<string>>();
      for (const { nameNormalized, pset_name } of flatProps) {
        const set = nameCounts.get(nameNormalized) ?? new Set<string>();
        set.add(pset_name);
        nameCounts.set(nameNormalized, set);
      }
      const conflictedNames = new Set(
        Array.from(nameCounts.entries())
          .filter(([, set]) => set.size > 1)
          .map(([name]) => name),
      );

      const defsList: PsetDefinition[] = raw.map((pset) => {
        const psetNameNormalized = normalizeName(pset.name);
        const props = (pset.props ?? []).map((prop, index) => {
          const nameNorm = normalizeName(prop.name);
          const finalName = conflictedNames.has(nameNorm)
            ? `${nameNorm}_${psetNameNormalized}`
            : nameNorm;
          return {
            prop_name: finalName,
            prop_type: prop.type,
            def_index: index,
          };
        });
        return {
          idx: pset.idx,
          name: pset.name,
          pset_name: pset.name,
          props,
        };
      });

      const schemaRows = defsList.flatMap((pset) =>
        pset.props.map((prop) => ({
          prop_name: prop.prop_name,
          prop_type: prop.prop_type,
        })),
      );

      return {
        defsList,
        parsedDefs: generateSchema(schemaRows),
      };
    },

    async ifcCollection(row: ModelFileRow): Promise<Record<string, unknown>[]> {
      const [modelData, ifcDefs] = await Promise.all([
        this.getModelData(row),
        this.getIFCPSetDefs(row.id, row.versionId),
      ]);

      const merged = mergeEntitiesWithIFCPSetDefs(modelData, ifcDefs.defsList);
      return schemaTransformTable(merged, ifcDefs.parsedDefs, 'ignoreMissing', 'nl-NL');
    },
  };
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function indexEntity(entity: ModelEntity): ModelEntity {
  const psets = (entity.psets ?? []).map((pset) => ({
    idx: pset.idx,
    pset_name: pset.pset_name ?? (pset as unknown as Record<string, unknown>).name,
    values: (pset.values ?? []).map((value, index) => {
      if (value && typeof value === 'object' && 'prop_value' in value) {
        return value as ModelPsetValue;
      }
      return { prop_value: value, value_index: index };
    }),
  }));

  return {
    ...entity,
    psets,
  };
}

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/^-+/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
