import type { ModelApi, ModelFileRow } from '../apis/model.js';
import type { PropertysetApi } from '../apis/propertyset.js';
import { mergeEntitiesWithIFCPSetDefs } from './entityMerger.js';
import { schemaTransformTable } from './schemaTransform.js';

export interface FullEntityTableOptions {
  propertysetToKeep?: string[];
  propertySetsDiscard?: string[];
  entityTextFilter?: string;
}

export async function getFullEntityTable(
  modelApi: ModelApi,
  propertysetApi: PropertysetApi,
  row: ModelFileRow,
  libIds: string[] | false,
  options: FullEntityTableOptions = {},
): Promise<Record<string, unknown>[]> {
  const textFilter = options.entityTextFilter?.trim();
  const filterString = textFilter ? `text=${encodeURIComponent(textFilter)}` : undefined;

  const [ifcDefs, modelData] = await Promise.all([
    modelApi.getIFCPSetDefs(row.id, row.versionId),
    modelApi.getModelData(row, undefined, filterString),
  ]);

  if (modelData.length === 0 && textFilter) {
    console.warn(`Entity text filter '${textFilter}' matched no entities; consider clearing connectorSettings.entityTextFilter`);
  }

  const ifcTable = mergeEntitiesWithIFCPSetDefs(modelData, ifcDefs.defsList, {
    propertysetToKeep: options.propertysetToKeep,
    propertySetsDiscard: options.propertySetsDiscard,
  });

  const typedIfcTable = schemaTransformTable(ifcTable, ifcDefs.parsedDefs, 'ignoreMissing', 'nl-NL');

  if (!libIds || libIds.length === 0) {
    return typedIfcTable;
  }

  const entityGuids = typedIfcTable.map((entity) => String(entity.GUID ?? '')).filter((guid) => guid.length > 0);
  const psetStart = Date.now();
  const trimbleData = await propertysetApi.getPsetsForEntities(entityGuids, { libIds });
  console.log(
    `Trimble psets: ${trimbleData.length} rows for ${entityGuids.length} entities in ${((Date.now() - psetStart) / 1000).toFixed(1)}s`,
  );
  const trimbleColumns = Object.keys(trimbleData[0] ?? {}).filter((c) => c !== 'link');

  const trimbleByLink = new Map<string, Record<string, unknown>>();
  for (const row of trimbleData) {
    trimbleByLink.set(String(row.Link), row);
  }

  return typedIfcTable.map((entity) => {
    const guid = String(entity.GUID ?? '');
    const trimbleRow = trimbleByLink.get(guid);
    if (!trimbleRow) return entity;

    const merged: Record<string, unknown> = { ...entity };
    for (const col of trimbleColumns) {
      if (!(col in merged)) {
        merged[col] = trimbleRow[col];
      }
    }
    return merged;
  });
}
