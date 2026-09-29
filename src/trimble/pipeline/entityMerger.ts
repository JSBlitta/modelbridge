import type { ModelEntity, PsetDefinition } from '../apis/model.js';
import type { SchemaColumn } from './schemaTransform.js';

export type MergeEntitiesWithIFCPSetDefs = (
  entities: ModelEntity[],
  psetDefs: PsetDefinition[],
  options?: MergeOptions,
) => Record<string, unknown>[];

export type SchemaTransformTable = (
  rows: Record<string, unknown>[],
  schema: SchemaColumn[],
  enforceSchema?: 'strict' | 'ignoreExtra' | 'ignoreMissing',
  culture?: string,
) => Record<string, unknown>[];

export interface MergeOptions {
  propertysetToKeep?: string[];
  propertySetsDiscard?: string[];
}

export function mergeEntitiesWithIFCPSetDefs(
  entities: ModelEntity[],
  psetDefs: PsetDefinition[],
  options: MergeOptions = {},
): Record<string, unknown>[] {
  const { propertysetToKeep = [], propertySetsDiscard = [] } = options;

  const filteredDefs = filterPsets(psetDefs, propertysetToKeep, propertySetsDiscard);

  const propNameLookup = new Map<string, string>();
  for (const pset of filteredDefs) {
    for (const prop of pset.props) {
      propNameLookup.set(`${pset.idx}_${prop.def_index}`, prop.prop_name);
    }
  }

  const mergedEntities = entities.map((entity) => {
    const psets = (entity.psets ?? [])
      .filter((pset) => shouldKeepPset(pset.pset_name, propertysetToKeep, propertySetsDiscard))
      .map((pset) => ({
        ...pset,
        values: pset.values.map((value) => ({
          ...value,
          prop_name:
            propNameLookup.get(`${pset.idx}_${value.value_index}`) ?? '[no name found]',
        })),
      }));

    return { ...entity, psets };
  });

  return pivotEntities(mergedEntities);
}

function filterPsets(
  psetDefs: PsetDefinition[],
  keep: string[],
  discard: string[],
): PsetDefinition[] {
  return psetDefs
    .filter((pset) => shouldKeepPset(pset.name, keep, discard))
    .map((pset) => ({
      ...pset,
      props: pset.props,
    }));
}

function shouldKeepPset(name: string, keep: string[], discard: string[]): boolean {
  if (keep.length > 0) {
    return keep.some((k) => equalsIgnoreCase(k, name));
  }
  if (discard.length > 0) {
    return !discard.some((d) => equalsIgnoreCase(d, name));
  }
  return true;
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface MergedPsetValue {
  prop_value: unknown;
  value_index: number;
  prop_name?: string;
}

function pivotEntities(entities: ModelEntity[]): Record<string, unknown>[] {
  const rows: Array<{ id: string; prop_name: string; prop_value: unknown }> = [];

  for (const entity of entities) {
    const id = entity.id;
    if ((entity.psets ?? []).length === 0) {
      rows.push({ id, prop_name: '_placeholder', prop_value: null });
      continue;
    }
    for (const pset of entity.psets ?? []) {
      for (const value of pset.values as MergedPsetValue[]) {
        rows.push({
          id,
          prop_name: value.prop_name ?? '[no name found]',
          prop_value: value.prop_value ?? '[no value found]',
        });
      }
    }
  }

  const result: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    if (!result[row.id]) {
      result[row.id] = { GUID: row.id };
    }
    if (row.prop_name !== '_placeholder') {
      result[row.id][row.prop_name] = row.prop_value;
    }
  }

  return Object.values(result);
}
