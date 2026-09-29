import { describe, it, expect, vi } from 'vitest';
import { run } from './run.js';
import { InMemoryDownstreamSink } from './output/downstreamApi.js';
import { InMemoryTokenStore } from './auth/tokenStore.js';
import type { Config } from './config/config.js';

const config: Config = {
  connectorSettings: {
    companyName: 'Blitta',
    companyFolderOnly: true,
    standardFields: ['id', 'product', 'psets', 'psets.name'],
    decimalPlaces: 2,
    batchChunkSize: 5000,
    expandAllFields: true,
    propertysetToKeep: [],
    propertySetsDiscard: [],
    entityTextFilter: 'CalculatedGeometryValues',
  },
  trimbleConnectAuthorization: {
    clientId: 'id',
    clientSecret: 'secret',
    scope: 'openid',
  },
  trimbleConnectURLs: {
    authorizeUri: 'https://id.trimble.com/oauth/authorize',
    tokenUri: 'https://id.trimble.com/oauth/token',
    redirectUri: 'https://example.com/callback',
    regionsUri: 'https://app.connect.trimble.com/tc/api/2.0/regions',
  },
  tableColumns: {
    projectsColumns: ['id', 'rootId', 'name', 'description'],
    folderColumns: ['id', 'name', 'type', 'versionId', 'projectId'],
    versionColumns: ['id', 'name', 'type', 'versionId', 'projectId', 'path', 'createdOn', 'modifiedOn'],
    releaseColumns: ['id', 'name', 'status', 'projectId', 'dueDate', 'notes', 'modifiedOn', 'createdOn'],
  },
};

describe('run', () => {
  it('discovers project, model, and sends entities to sink', async () => {
    const sink = new InMemoryDownstreamSink();
    const tokenStore = new InMemoryTokenStore();
    tokenStore.setTokens({ access_token: 'token' });

    const fetchFn = vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
      if (url.includes('/tc/api/2.0/projects')) {
        return jsonResponse([{ id: 'p1', rootId: 'root-1', name: 'Project 1' }]);
      }
      if (url.includes('/folders/root-1/items')) {
        return jsonResponse([{ id: 'file-1', name: 'model.ifc', type: 'FILE', projectId: 'p1' }]);
      }
      if (url.includes('/files/file-1/versions')) {
        return jsonResponse([{ id: 'file-1', name: 'model.ifc', type: 'File', versionId: 'v1', projectId: 'p1' }]);
      }
      if (url.includes('/forests/p1/trees')) {
        return jsonResponse({ items: [] });
      }
      if (url.includes('/forests/project:p1:data/trees/ProjectContext/nodes/PSetLibs')) {
        return jsonResponse({ links: ['frn:lib:lib-1'] });
      }
      if (url.includes('/batch-get')) {
        return jsonResponse({
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
        });
      }
      if (url.includes('/libs/lib-1/defs')) {
        return jsonResponse({
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
      }
      if (url.includes('/psets/frn:entity:e1') || url.includes('/psets/frn%3Aentity%3Ae1')) {
        return jsonResponse({
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
      }
      if (url.includes('/models/file-1/psetdefs')) {
        return jsonResponse({
          items: [
            {
              idx: 1,
              name: 'Pset_WallCommon',
              props: [{ name: 'Reference', type: 'string' }],
            },
          ],
        });
      }
      if (url.includes('/models/file-1/entities')) {
        return jsonResponse({
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
        });
      }
      return new Response('{}', { status: 200 });
    });

    const result = await run({ region: 'Europe' }, { config, tokenStore, sink, fetchFn });

    expect(result.projectId).toBe('p1');
    expect(result.modelId).toBe('file-1');
    expect(result.entityCount).toBe(1);
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]?.tableName).toBe('entities');
    expect(sink.batches[0]?.rows[0]).toMatchObject({ GUID: 'e1', Reference: 'REF-001', Status: 'Active' });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
