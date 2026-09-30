import { describe, it, expect, vi } from 'vitest';
import { createModelApi } from './model.js';
import type { HttpClient } from '../http/client.js';
import type { RegionEndpoints } from '../types/index.js';
import { hasFixtures, loadFixture } from '../test/fixtures.js';

const endpoints: RegionEndpoints = {
  Core: 'https://app21.connect.trimble.com/tc/api/2.0/',
  Organizer: 'https://org-api.eu-west-1.connect.trimble.com/v1/',
  Propertyset: 'https://pset-api.eu-west-1.connect.trimble.com/v1/',
  Model: 'https://model-api21.connect.trimble.com/',
  Topic: 'https://open21.connect.trimble.com/',
  'Model-feature': 'https://model-wf21.connect.trimble.com/v1/',
};

function createMockClient() {
  const get = vi.fn();
  const post = vi.fn();
  return { get, post, client: { get, post } as unknown as HttpClient };
}

describe('createModelApi', () => {
  it('fetches identifiers', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [{ id: 'e1' }, { id: 'e2' }],
    });

    const api = createModelApi(client, endpoints);
    const ids = await api.getIdentifiers('model-1', 'v1');

    expect(ids).toEqual([{ id: 'e1' }, { id: 'e2' }]);
    const [url] = get.mock.calls[0];
    expect(url).toContain('models/model-1/entities/');
    expect(url).toContain('fields=id');
    expect(url).toContain('versionId=v1');
  });

  it('batch-gets entities', async () => {
    const { post, client } = createMockClient();
    post.mockResolvedValueOnce({
      responses: {
        entities: [{ id: 'e1' }, { id: 'e2' }],
      },
    });

    const api = createModelApi(client, endpoints);
    const entities = await api.batchGet('model-1', [{ id: 'e1' }, { id: 'e2' }], 'v1', '&fields=id');

    expect(entities).toEqual([{ id: 'e1' }, { id: 'e2' }]);
    const [url, body] = post.mock.calls[0];
    expect(url).toContain('models/model-1/batch-get');
    expect(url).toContain('fields=id');
    expect(url).toContain('versionId=v1');
    expect(body).toEqual({ entities: [{ id: 'e1' }, { id: 'e2' }] });
  });

  it('fetches IFC pset definitions', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        {
          idx: 1,
          name: 'Pset_WallCommon',
          props: [
            { name: 'Reference', type: 'string' },
            { name: 'LoadBearing', type: 'boolean' },
          ],
        },
      ],
    });

    const api = createModelApi(client, endpoints);
    const defs = await api.getIFCPSetDefs('model-1', 'v1');

    expect(defs.defsList).toEqual([
      {
        idx: 1,
        name: 'Pset_WallCommon',
        pset_name: 'Pset_WallCommon',
        props: [
          { prop_name: 'Reference', prop_type: 'string', def_index: 0 },
          { prop_name: 'LoadBearing', prop_type: 'boolean', def_index: 1 },
        ],
      },
    ]);
    expect(defs.parsedDefs).toContainEqual({ name: 'GUID', type: 'string' });
    expect(defs.parsedDefs).toContainEqual({ name: 'Reference', type: 'string' });
  });

  it('handles name conflicts across psets', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        {
          idx: 1,
          name: 'Pset_A',
          props: [{ name: 'Status', type: 'string' }],
        },
        {
          idx: 2,
          name: 'Pset_B',
          props: [{ name: 'Status', type: 'string' }],
        },
      ],
    });

    const api = createModelApi(client, endpoints);
    const defs = await api.getIFCPSetDefs('model-1');

    const psetA = defs.defsList[0]?.props[0];
    const psetB = defs.defsList[1]?.props[0];
    expect(psetA?.prop_name).toBe('Status_Pset_A');
    expect(psetB?.prop_name).toBe('Status_Pset_B');
  });

  it('runs ifcCollection end-to-end', async () => {
    const { get, client } = createMockClient();

    get.mockImplementation(async (url: string) => {
      if (url.includes('/psetdefs')) {
        return {
          items: [
            {
              idx: 1,
              name: 'Pset_WallCommon',
              props: [{ name: 'Reference', type: 'string' }],
            },
          ],
        };
      }
      return {
        items: [
          {
            id: 'e1',
            psets: [
              {
                idx: 1,
                pset_name: 'Pset_WallCommon',
                values: ['REF-001'],
              },
            ],
          },
        ],
      };
    });

    const api = createModelApi(client, endpoints);
    const rows = await api.ifcCollection({ id: 'model-1', projectId: 'p1', versionId: 'v1' });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      GUID: 'e1',
      Reference: 'REF-001',
    });
  });
});

describe('createModelApi fixture verification', () => {
  it.skipIf(!hasFixtures)('parses the real model entities response', async () => {
    const { get, client } = createMockClient();
    const fixture = loadFixture('model models modelid entities qparams pset psets.json') as {
      items: Array<Record<string, unknown>>;
      total: number;
    };

    get
      .mockResolvedValueOnce(fixture)
      .mockResolvedValueOnce({ items: [], total: fixture.total });

    const api = createModelApi(client, endpoints);
    const ids = await api.getIdentifiers('model-1');

    expect(ids.length).toBe(fixture.items.length);
    expect(ids[0]?.id).toBe(fixture.items[0]?.id);
  });
});
