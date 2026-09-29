import { describe, it, expect } from 'vitest';
import { mergeEntitiesWithIFCPSetDefs } from './entityMerger.js';
import type { ModelEntity, PsetDefinition } from '../apis/model.js';

describe('mergeEntitiesWithIFCPSetDefs', () => {
  it('merges IFC entities with their property sets', () => {
    const entities: ModelEntity[] = [
      {
        id: 'e1',
        psets: [
          {
            idx: 1,
            pset_name: 'Pset_WallCommon',
            values: [
              { prop_value: 'REF-001', value_index: 0 },
              { prop_value: true, value_index: 1 },
            ],
          },
        ],
      },
    ];

    const psetDefs: PsetDefinition[] = [
      {
        idx: 1,
        name: 'Pset_WallCommon',
        pset_name: 'Pset_WallCommon',
        props: [
          { prop_name: 'Reference', prop_type: 'string', def_index: 0 },
          { prop_name: 'LoadBearing', prop_type: 'boolean', def_index: 1 },
        ],
      },
    ];

    const rows = mergeEntitiesWithIFCPSetDefs(entities, psetDefs);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      GUID: 'e1',
      Reference: 'REF-001',
      LoadBearing: true,
    });
  });

  it('filters out discarded property sets', () => {
    const entities: ModelEntity[] = [
      {
        id: 'e1',
        psets: [
          {
            idx: 1,
            pset_name: 'IfcMaterial',
            values: [{ prop_value: 'Concrete', value_index: 0 }],
          },
        ],
      },
    ];

    const psetDefs: PsetDefinition[] = [
      {
        idx: 1,
        name: 'IfcMaterial',
        pset_name: 'IfcMaterial',
        props: [{ prop_name: 'Name', prop_type: 'string', def_index: 0 }],
      },
    ];

    const rows = mergeEntitiesWithIFCPSetDefs(entities, psetDefs, {
      propertySetsDiscard: ['IfcMaterial'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ GUID: 'e1' });
  });

  it('keeps only selected property sets when keep list is provided', () => {
    const entities: ModelEntity[] = [
      {
        id: 'e1',
        psets: [
          {
            idx: 1,
            pset_name: 'BLITTA',
            values: [{ prop_value: 'A', value_index: 0 }],
          },
          {
            idx: 2,
            pset_name: 'Other',
            values: [{ prop_value: 'B', value_index: 0 }],
          },
        ],
      },
    ];

    const psetDefs: PsetDefinition[] = [
      {
        idx: 1,
        name: 'BLITTA',
        pset_name: 'BLITTA',
        props: [{ prop_name: 'BlittaProp', prop_type: 'string', def_index: 0 }],
      },
      {
        idx: 2,
        name: 'Other',
        pset_name: 'Other',
        props: [{ prop_name: 'OtherProp', prop_type: 'string', def_index: 0 }],
      },
    ];

    const rows = mergeEntitiesWithIFCPSetDefs(entities, psetDefs, {
      propertysetToKeep: ['BLITTA'],
    });

    expect(rows[0]).toEqual({ GUID: 'e1', BlittaProp: 'A' });
  });
});
