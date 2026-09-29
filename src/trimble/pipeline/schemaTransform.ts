export interface SchemaColumn {
  name: string;
  type: string;
}

export type EnforceSchemaMode = 'strict' | 'ignoreExtra' | 'ignoreMissing';

export function schemaTransformTable(
  rows: Record<string, unknown>[],
  schema: SchemaColumn[],
  enforceSchema: EnforceSchemaMode = 'strict',
  _culture?: string,
): Record<string, unknown>[] {
  if (rows.length === 0) return [];

  const schemaMap = new Map<string, string>();
  for (const col of schema) {
    schemaMap.set(col.name, col.type);
  }

  const schemaNames = Array.from(schemaMap.keys());
  const result: Record<string, unknown>[] = [];

  for (const row of rows) {
    const newRow: Record<string, unknown> = {};

    if (enforceSchema === 'strict' || enforceSchema === 'ignoreExtra') {
      for (const name of schemaNames) {
        newRow[name] = row[name] ?? null;
      }
      if (enforceSchema === 'ignoreExtra') {
        for (const key of Object.keys(row)) {
          if (!schemaMap.has(key)) {
            newRow[key] = row[key];
          }
        }
      }
    } else {
      for (const key of Object.keys(row)) {
        newRow[key] = row[key];
      }
      for (const name of schemaNames) {
        if (!(name in newRow)) {
          newRow[name] = null;
        }
      }
    }

    for (const [name, type] of schemaMap) {
      if (name in newRow) {
        newRow[name] = coerceValue(newRow[name], type);
      }
    }

    result.push(newRow);
  }

  return result;
}

export function generateSchema(psetDefs: Array<{ prop_name: string; prop_type: string }>): SchemaColumn[] {
  const seen = new Set<string>();
  const result: SchemaColumn[] = [];

  for (const def of psetDefs) {
    if (!def.prop_type) continue;
    if (seen.has(def.prop_name)) continue;
    seen.add(def.prop_name);
    result.push({ name: def.prop_name, type: def.prop_type });
  }

  result.unshift({ name: 'GUID', type: 'string' });
  return result;
}

function coerceValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;

  const lowerType = String(type).toLowerCase();

  if (lowerType.includes('integer')) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : null;
  }

  if (
    lowerType.includes('number') ||
    lowerType.includes('mass') ||
    lowerType.includes('leng') ||
    lowerType.includes('area') ||
    lowerType.includes('volume') ||
    lowerType.includes('angl')
  ) {
    return coerceNumber(value);
  }

  if (lowerType.includes('bool')) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return Boolean(value);
  }

  if (lowerType.includes('string')) {
    return String(value);
  }

  return value;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalized = value.replace(',', '.');
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
