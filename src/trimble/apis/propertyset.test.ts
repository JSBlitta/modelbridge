import { describe, it, expect, vi } from 'vitest';
import { createPropertysetApi } from './propertyset.js';
import type { HttpClient } from '../http/client.js';
import type { RegionEndpoints } from '../types/index.js';
import { loadFixture } from '../test/fixtures.js';

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

describe('createPropertysetApi', () => {
  it('fetches property set library definitions', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        {
          v: 1,
          libId: 'lib-1',
          id: 'def-1',
          i18n: {
            'en-US': {
              name: 'My Pset',
              props: { prop1: 'Status' },
            },
          },
          schema: {
            props: {
              prop1: { type: 'string' },
            },
          },
        },
      ],
    });

    const api = createPropertysetApi(client, endpoints);
    const defs = await api.getPSetLibDefs('p1', ['lib-1']);

    expect(defs).toEqual([
      {
        version: 1,
        libId: 'lib-1',
        defId: 'def-1',
        PSetName: 'My Pset',
        PropId: 'prop1',
        prop_name: 'Status',
        prop_type: 'string',
        Description: '',
        Enum: '',
      },
    ]);
  });

  it('fetches Trimble psets and collapses to one row per entity', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        { link: 'frn:entity:e1', props: { prop1: 'Active' } },
        { link: 'frn:entity:e1', props: { prop2: 'Second' } },
      ],
    });

    const api = createPropertysetApi(client, endpoints);
    const rows = await api.getTrimblePsets('p1', [
      { libId: 'lib-1', defId: 'def-1', PropId: 'prop1', prop_name: 'Status', prop_type: 'string', PSetName: 'P', version: 1, Description: '', Enum: '' },
      { libId: 'lib-1', defId: 'def-1', PropId: 'prop2', prop_name: 'Note', prop_type: 'string', PSetName: 'P', version: 1, Description: '', Enum: '' },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Link: 'e1',
      Status: 'Active',
      Note: 'Second',
    });
  });
});

describe('createPropertysetApi fixture verification', () => {
  it('parses the real library definitions response', async () => {
    const { get, client } = createMockClient();
    const fixture = loadFixture('propertyset libs libid defs.json') as { items: Array<Record<string, unknown>> };
    get.mockResolvedValueOnce(fixture);

    const api = createPropertysetApi(client, endpoints);
    const defs = await api.getPSetLibDefs('p1', ['lib-1']);

    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]).toMatchObject({
      libId: expect.any(String),
      defId: expect.any(String),
      PSetName: expect.any(String),
      prop_name: expect.any(String),
      prop_type: expect.any(String),
    });
  });

  it('parses the real psets-from-definition response', async () => {
    const { get, client } = createMockClient();
    const fixture = loadFixture('propertyset libs libid defs defid psets.json') as {
      items: Array<Record<string, unknown>>;
    };
    get.mockResolvedValueOnce(fixture);

    const api = createPropertysetApi(client, endpoints);
    const rows = await api.getTrimblePsets('p1', [
      { libId: 'lib-1', defId: 'def-1', PropId: 'prop1', prop_name: 'Prop One', prop_type: 'string', PSetName: 'P', version: 1, Description: '', Enum: '' },
    ]);

    expect(rows.length).toBeGreaterThan(0);
  });

  it('fetches psets for a single entity link', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        {
          link: 'frn:entity:e1',
          libId: 'lib-1',
          defId: 'def-1',
          v: 1,
          schemaV: 1,
          props: { prop1: 'Active' },
        },
      ],
    });

    const api = createPropertysetApi(client, endpoints);
    const instances = await api.getPsetsByLink('frn:entity:e1');

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      link: 'frn:entity:e1',
      libId: 'lib-1',
      defId: 'def-1',
      props: { prop1: 'Active' },
    });
    expect(get).toHaveBeenCalledWith(
      `${endpoints.Propertyset}psets/${encodeURIComponent('frn:entity:e1')}?top=500`,
    );
  });

  it('fetches psets for multiple entities and resolves definitions via batch-get', async () => {
    const { get, post, client } = createMockClient();

    get.mockResolvedValueOnce({
      items: [
        {
          link: 'frn:entity:e1',
          libId: 'lib-1',
          defId: 'def-1',
          v: 1,
          schemaV: 1,
          props: { prop1: 'Active' },
        },
      ],
    });
    get.mockResolvedValueOnce({
      items: [
        {
          link: 'frn:entity:e2',
          libId: 'lib-1',
          defId: 'def-1',
          v: 1,
          schemaV: 1,
          props: { prop1: 'Inactive' },
        },
      ],
    });
    post.mockResolvedValueOnce({
      responses: {
        defs: [
          {
            v: 1,
            libId: 'lib-1',
            id: 'def-1',
            i18n: {
              'en-US': {
                name: 'My Pset',
                props: { prop1: 'Status' },
              },
            },
            schema: {
              props: {
                prop1: { type: 'string' },
              },
            },
          },
        ],
      },
    });

    const api = createPropertysetApi(client, endpoints);
    const rows = await api.getPsetsForEntities(['e1', 'e2'], { concurrency: 2 });

    expect(post).toHaveBeenCalledWith(`${endpoints.Propertyset}batch-get`, {
      defs: [{ libId: 'lib-1', defId: 'def-1' }],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Link: 'e1', Status: 'Active' });
    expect(rows[1]).toMatchObject({ Link: 'e2', Status: 'Inactive' });
  });

  it('renames identical PropIds per library and definition', async () => {
    const { get, post, client } = createMockClient();

    get.mockResolvedValueOnce({
      items: [
        {
          link: 'frn:entity:e1',
          libId: 'lib-1',
          defId: 'def-1',
          v: 1,
          schemaV: 1,
          props: { prop1: 'Active' },
        },
      ],
    });
    get.mockResolvedValueOnce({
      items: [
        {
          link: 'frn:entity:e2',
          libId: 'lib-2',
          defId: 'def-2',
          v: 1,
          schemaV: 1,
          props: { prop1: '42' },
        },
      ],
    });
    post.mockResolvedValueOnce({
      responses: {
        defs: [
          {
            v: 1,
            libId: 'lib-1',
            id: 'def-1',
            i18n: { 'en-US': { name: 'Pset A', props: { prop1: 'Status' } } },
            schema: { props: { prop1: { type: 'string' } } },
          },
          {
            v: 1,
            libId: 'lib-2',
            id: 'def-2',
            i18n: { 'en-US': { name: 'Pset B', props: { prop1: 'Volume' } } },
            schema: { props: { prop1: { type: 'string' } } },
          },
        ],
      },
    });

    const api = createPropertysetApi(client, endpoints);
    const rows = await api.getPsetsForEntities(['e1', 'e2'], { concurrency: 2 });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Link: 'e1', Status: 'Active' });
    expect(rows[1]).toMatchObject({ Link: 'e2', Volume: '42' });
  });

  it('falls back to another locale when en-US is missing', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        {
          v: 1,
          libId: 'lib-1',
          id: 'def-1',
          name: 'Fallback Name',
          i18n: {
            '__definition-sort-order__': {
              name: '__definition-sort-order__',
              props: { '__definition-sort-order__': '0' },
            },
            'nl-NL': {
              name: 'Mijn Pset',
              props: { prop1: 'Status NL' },
            },
          },
          schema: {
            props: {
              prop1: { type: 'string' },
            },
          },
        },
      ],
    });

    const api = createPropertysetApi(client, endpoints);
    const defs = await api.getPSetLibDefs('p1', ['lib-1']);

    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ PSetName: 'Mijn Pset', prop_name: 'Status NL' });
  });

  it('falls back to definition name and PropId when i18n is missing', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        {
          v: 1,
          libId: 'lib-1',
          id: 'def-1',
          name: 'Untranslated Def',
          schema: {
            props: {
              prop1: { type: 'string' },
            },
          },
        },
      ],
    });

    const api = createPropertysetApi(client, endpoints);
    const defs = await api.getPSetLibDefs('p1', ['lib-1']);

    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ PSetName: 'Untranslated Def', prop_name: 'prop1' });
  });

  it('batch-gets definitions and retries unprocessed refs', async () => {
    const { post, client } = createMockClient();

    post.mockResolvedValueOnce({
      responses: {
        defs: [
          {
            v: 1,
            libId: 'lib-1',
            id: 'def-1',
            i18n: { 'en-US': { name: 'Pset A', props: { prop1: 'Status' } } },
            schema: { props: { prop1: { type: 'string' } } },
          },
        ],
      },
      unprocessed: { defs: [{ libId: 'lib-2', defId: 'def-2' }] },
    });
    post.mockResolvedValueOnce({
      responses: {
        defs: [
          {
            v: 1,
            libId: 'lib-2',
            id: 'def-2',
            i18n: { 'en-US': { name: 'Pset B', props: { prop2: 'Volume' } } },
            schema: { props: { prop2: { type: 'string' } } },
          },
        ],
      },
    });

    const api = createPropertysetApi(client, endpoints);
    const defs = await api.batchGetDefinitions([
      { libId: 'lib-1', defId: 'def-1' },
      { libId: 'lib-2', defId: 'def-2' },
      { libId: 'lib-1', defId: 'def-1' },
    ]);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(1, `${endpoints.Propertyset}batch-get`, {
      defs: [
        { libId: 'lib-1', defId: 'def-1' },
        { libId: 'lib-2', defId: 'def-2' },
      ],
    });
    expect(post).toHaveBeenNthCalledWith(2, `${endpoints.Propertyset}batch-get`, {
      defs: [{ libId: 'lib-2', defId: 'def-2' }],
    });
    expect(defs).toHaveLength(2);
    expect(defs.map((def) => def.prop_name).sort()).toEqual(['Status', 'Volume']);
  });

  it('fetches psets per definition via batch-get when project libraries are known', async () => {
    const { get, post, client } = createMockClient();

    get.mockResolvedValueOnce({
      items: [
        {
          v: 1,
          libId: 'lib-1',
          id: 'def-1',
          i18n: { 'en-US': { name: 'My Pset', props: { prop1: 'Status' } } },
          schema: { props: { prop1: { type: 'string' } } },
        },
      ],
    });
    post.mockResolvedValueOnce({
      responses: {
        psets: [
          {
            link: 'frn:entity:e1',
            libId: 'lib-1',
            defId: 'def-1',
            v: 1,
            schemaV: 1,
            props: { prop1: 'Active' },
          },
        ],
      },
      errors: {
        psets: [{ item: { link: 'frn:entity:e2', libId: 'lib-1', defId: 'def-1' }, code: 'NotFound', message: 'no pset' }],
      },
    });

    const api = createPropertysetApi(client, endpoints);
    const rows = await api.getPsetsForEntities(['e1', 'e2'], { libIds: ['lib-1'] });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.stringContaining('libs/lib-1/defs'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(`${endpoints.Propertyset}batch-get`, {
      psets: [
        { link: 'frn:entity:e1', libId: 'lib-1', defId: 'def-1' },
        { link: 'frn:entity:e2', libId: 'lib-1', defId: 'def-1' },
      ],
    });
    expect(rows).toEqual([{ Link: 'e1', Status: 'Active' }]);
  });

  it('returns empty array when no entity has psets', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValue({ items: [] });

    const api = createPropertysetApi(client, endpoints);
    const rows = await api.getPsetsForEntities(['e1', 'e2']);

    expect(rows).toHaveLength(0);
  });
});
