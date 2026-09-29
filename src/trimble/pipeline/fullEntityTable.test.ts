import { describe, it, expect, vi } from 'vitest';
import { getFullEntityTable } from './fullEntityTable.js';
import type { ModelApi } from '../apis/model.js';
import type { PropertysetApi } from '../apis/propertyset.js';

function createMockModelApi() {
  return {
    getIFCPSetDefs: vi.fn(),
    getModelData: vi.fn(),
  } as unknown as ModelApi;
}

function createMockPropertysetApi() {
  return {
    getPsetsForEntities: vi.fn(),
  } as unknown as PropertysetApi;
}

describe('getFullEntityTable', () => {
  it('returns IFC-only data when no Trimble libraries exist', async () => {
    const modelApi = createMockModelApi();
    const propertysetApi = createMockPropertysetApi();

    modelApi.getIFCPSetDefs = vi.fn().mockResolvedValue({
      defsList: [
        { idx: 1, name: 'Pset', pset_name: 'Pset', props: [{ prop_name: 'Reference', prop_type: 'string', def_index: 0 }] },
      ],
      parsedDefs: [
        { name: 'GUID', type: 'string' },
        { name: 'Reference', type: 'string' },
      ],
    });

    modelApi.getModelData = vi.fn().mockResolvedValue([
      { id: 'e1', psets: [{ idx: 1, pset_name: 'Pset', values: [{ prop_value: 'REF-001', value_index: 0 }] }] },
    ]);

    const rows = await getFullEntityTable(
      modelApi,
      propertysetApi,
      { id: 'model-1', projectId: 'p1', versionId: 'v1' },
      false,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ GUID: 'e1', Reference: 'REF-001' });
  });

  it('joins Trimble pset data when libraries exist', async () => {
    const modelApi = createMockModelApi();
    const propertysetApi = createMockPropertysetApi();

    modelApi.getIFCPSetDefs = vi.fn().mockResolvedValue({
      defsList: [],
      parsedDefs: [{ name: 'GUID', type: 'string' }],
    });

    modelApi.getModelData = vi.fn().mockResolvedValue([{ id: 'e1', psets: [] }]);

    propertysetApi.getPsetsForEntities = vi.fn().mockResolvedValue([
      { Link: 'e1', Status: 'Active' },
    ]);

    const rows = await getFullEntityTable(
      modelApi,
      propertysetApi,
      { id: 'model-1', projectId: 'p1', versionId: 'v1' },
      ['lib-1'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ GUID: 'e1', Status: 'Active' });
  });

  it('passes the entity text filter to the model API', async () => {
    const modelApi = createMockModelApi();
    const propertysetApi = createMockPropertysetApi();

    modelApi.getIFCPSetDefs = vi.fn().mockResolvedValue({
      defsList: [],
      parsedDefs: [{ name: 'GUID', type: 'string' }],
    });
    modelApi.getModelData = vi.fn().mockResolvedValue([{ id: 'e1', psets: [] }]);

    const rows = await getFullEntityTable(
      modelApi,
      propertysetApi,
      { id: 'model-1', projectId: 'p1', versionId: 'v1' },
      false,
      { entityTextFilter: 'CalculatedGeometryValues' },
    );

    expect(modelApi.getModelData).toHaveBeenCalledWith(
      { id: 'model-1', projectId: 'p1', versionId: 'v1' },
      undefined,
      'text=CalculatedGeometryValues',
    );
    expect(rows).toHaveLength(1);
  });

  it('fetches unfiltered when the entity text filter is empty', async () => {
    const modelApi = createMockModelApi();
    const propertysetApi = createMockPropertysetApi();

    modelApi.getIFCPSetDefs = vi.fn().mockResolvedValue({
      defsList: [],
      parsedDefs: [{ name: 'GUID', type: 'string' }],
    });
    modelApi.getModelData = vi.fn().mockResolvedValue([{ id: 'e1', psets: [] }]);

    await getFullEntityTable(
      modelApi,
      propertysetApi,
      { id: 'model-1', projectId: 'p1', versionId: 'v1' },
      false,
      { entityTextFilter: '' },
    );

    expect(modelApi.getModelData).toHaveBeenCalledWith(
      { id: 'model-1', projectId: 'p1', versionId: 'v1' },
      undefined,
      undefined,
    );
  });
});
