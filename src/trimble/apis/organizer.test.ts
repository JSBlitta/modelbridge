import { describe, it, expect, vi } from 'vitest';
import { createOrganizerApi } from './organizer.js';
import type { HttpClient } from '../http/client.js';
import type { RegionEndpoints } from '../types/index.js';
import { NotFoundError } from '../http/errors.js';
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

describe('createOrganizerApi', () => {
  it('fetches project trees', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [{ forestId: 'f1', id: 'tree-1', v: 1, name: 'My%20Tree' }],
    });

    const api = createOrganizerApi(client, endpoints);
    const trees = await api.getProjectTrees('p1');

    expect(trees).toEqual([{ forestId: 'f1', treeId: 'tree-1', treeV: 1, treeName: 'My Tree' }]);
  });

  it('returns empty trees on 404', async () => {
    const { get, client } = createMockClient();
    get.mockRejectedValueOnce(new NotFoundError('url'));

    const api = createOrganizerApi(client, endpoints);
    const trees = await api.getProjectTrees('p1');

    expect(trees).toEqual([]);
  });

  it('fetches project library IDs and keeps compound resource ids intact', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      links: [
        'frn:lib:lib-1%3Ap1%3Ab51c1ecd-9b66-44e9-26b5-163bf35bfb09',
        'frn:lib:lib-2%3Ap1%3A11d6a7a4-d154-3ac5-1d9b-56b61352af2e',
      ],
    });

    const api = createOrganizerApi(client, endpoints);
    const libIds = await api.getProjectLibraryIds('p1');

    expect(libIds).toEqual([
      'lib-1:p1:b51c1ecd-9b66-44e9-26b5-163bf35bfb09',
      'lib-2:p1:11d6a7a4-d154-3ac5-1d9b-56b61352af2e',
    ]);
  });

  it('returns empty library IDs on 404', async () => {
    const { get, client } = createMockClient();
    get.mockRejectedValueOnce(new NotFoundError('url'));

    const api = createOrganizerApi(client, endpoints);
    const libIds = await api.getProjectLibraryIds('p1');

    expect(libIds).toEqual([]);
  });

  it('fetches project nodes with metadata when requested', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({
      items: [
        {
          forestId: 'f1',
          treeId: 'tree-1',
          id: 'node-1',
          v: 2,
          name: 'My%20Node',
          count: 3,
          metadata: { discipline: 'HV' },
        },
      ],
    });

    const api = createOrganizerApi(client, endpoints);
    const nodes = await api.getProjectNodes('p1', 'tree-1', { includeMetadata: true });

    expect(get).toHaveBeenCalledWith(expect.stringContaining('fields=metadata'));
    expect(nodes).toEqual([
      {
        forestId: 'f1',
        treeId: 'tree-1',
        nodeId: 'node-1',
        nodeV: 2,
        nodeName: 'My Node',
        entitiesCount: 3,
        metadata: { discipline: 'HV' },
      },
    ]);
  });

  it('batch-gets nodes and retries unprocessed identities', async () => {
    const { post, client } = createMockClient();

    post.mockResolvedValueOnce({
      responses: {
        nodes: [
          { forestId: 'p1', treeId: 'tree-1', id: 'node-1', v: 1, name: 'Node One', count: 2 },
        ],
      },
      unprocessed: { nodes: [{ forestId: 'p1', treeId: 'tree-1', nodeId: 'node-2' }] },
    });
    post.mockResolvedValueOnce({
      responses: {
        nodes: [
          {
            forestId: 'p1',
            treeId: 'tree-1',
            id: 'node-2',
            v: 1,
            name: 'Node Two',
            count: 0,
            metadata: { system: 'air' },
          },
        ],
      },
    });

    const api = createOrganizerApi(client, endpoints);
    const nodes = await api.batchGetNodes(
      'p1',
      [
        { treeId: 'tree-1', nodeId: 'node-1' },
        { treeId: 'tree-1', nodeId: 'node-2' },
        { treeId: 'tree-1', nodeId: 'node-1' },
      ],
      { includeMetadata: true },
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(
      1,
      `${endpoints.Organizer}batch-get?nolinks=true&fields=metadata`,
      {
        nodes: [
          { forestId: 'p1', treeId: 'tree-1', nodeId: 'node-1' },
          { forestId: 'p1', treeId: 'tree-1', nodeId: 'node-2' },
        ],
      },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      `${endpoints.Organizer}batch-get?nolinks=true&fields=metadata`,
      { nodes: [{ forestId: 'p1', treeId: 'tree-1', nodeId: 'node-2' }] },
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ nodeId: 'node-1', nodeName: 'Node One', entitiesCount: 2 });
    expect(nodes[1]).toMatchObject({ nodeId: 'node-2', metadata: { system: 'air' } });
  });
});

describe('createOrganizerApi fixture verification', () => {
  it.skipIf(!hasFixtures)('parses the real ProjectContext PSetLibs node', async () => {
    const { get, client } = createMockClient();
    const fixture = loadFixture('organiser forrest forest-projectid-data trees projectcontext psetlibs.json') as {
      links: string[];
    };
    get.mockResolvedValueOnce(fixture);

    const api = createOrganizerApi(client, endpoints);
    const libIds = await api.getProjectLibraryIds('projectid');

    expect(libIds.length).toBe(fixture.links.length);
    expect(libIds[0]).not.toMatch(/^frn:/);
  });
});
