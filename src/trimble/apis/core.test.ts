import { describe, it, expect, vi } from 'vitest';
import { createCoreApi } from './core.js';
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

describe('createCoreApi', () => {
  it('fetches projects and adds Folder/IsLeaf metadata', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce([
      { id: 'p1', rootId: 'r1', name: 'Project One', description: 'Test' },
    ]);

    const api = createCoreApi(client, endpoints);
    const projects = await api.getProjects();

    expect(projects).toEqual([
      { id: 'p1', rootId: 'r1', name: 'Project One', description: 'Test', type: 'Folder', IsLeaf: false },
    ]);

    const [url] = get.mock.calls[0];
    expect(url).toContain(`${endpoints.Core}projects`);
    expect(url).toContain('fullyLoaded=false');
    expect(url).toContain('sort=-name');
  });

  it('searches projects', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce([{ details: { id: 'p1' } }]);

    const api = createCoreApi(client, endpoints);
    const result = await api.searchProject('demo');

    expect(result).toEqual([{ details: { id: 'p1' } }]);
    const [url] = get.mock.calls[0];
    expect(url).toBe(`${endpoints.Core}search?query=demo&type=PROJECT`);
  });

  it('fetches folder items and normalizes types', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce([
      { id: 'f1', name: 'Models', type: 'FOLDER' },
      { id: 'f2', name: 'model.ifc', type: 'FILE', versionId: 'v1', projectId: 'p1' },
    ]);

    const api = createCoreApi(client, endpoints);
    const items = await api.getFolderItems('folder-1');

    expect(items).toEqual([
      { id: 'f1', name: 'Models', type: 'Folder' },
      { id: 'f2', name: 'model.ifc', type: 'File', versionId: 'v1', projectId: 'p1' },
    ]);

    const [url] = get.mock.calls[0];
    expect(url).toContain(`${endpoints.Core}folders/folder-1/items`);
  });

  it('fetches file versions and renames with revision', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce([
      { id: 'v1', name: 'model.ifc', type: 'File', versionId: 'v1', projectId: 'p1', revision: '2' },
    ]);

    const api = createCoreApi(client, endpoints);
    const versions = await api.getFileVersions('file-1');

    expect(versions).toEqual([
      { id: 'v1', name: 'model.ifc Rev. 2', type: 'File', versionId: 'v1', projectId: 'p1', revision: '2' },
    ]);
  });

  it('fetches releases for a project', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce([{ id: 'rel1', name: 'Release 1', status: 'open', projectId: 'p1' }]);

    const api = createCoreApi(client, endpoints);
    const releases = await api.getReleases('p1');

    expect(releases).toEqual([{ id: 'rel1', name: 'Release 1', status: 'open', projectId: 'p1' }]);
    const [url] = get.mock.calls[0];
    expect(url).toBe(`${endpoints.Core}releases?projectId=p1`);
  });

  it('fetches release files from an array response and attaches projectId', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce([{ id: 'rf1', name: 'model.ifc', type: 'File', versionId: 'v1' }]);

    const api = createCoreApi(client, endpoints);
    const files = await api.getReleaseFiles('rel1', 'p1');

    expect(files).toEqual([{ id: 'rf1', name: 'model.ifc', type: 'File', versionId: 'v1', projectId: 'p1' }]);
  });

  it('wraps a single release-file object into an array', async () => {
    const { get, client } = createMockClient();
    get.mockResolvedValueOnce({ id: 'rf1', name: 'model.ifc', type: 'File', versionId: 'v1' });

    const api = createCoreApi(client, endpoints);
    const files = await api.getReleaseFiles('rel1', 'p1');

    expect(files).toEqual([{ id: 'rf1', name: 'model.ifc', type: 'File', versionId: 'v1', projectId: 'p1' }]);
  });
});

describe('createCoreApi fixture verification', () => {
  it.skipIf(!hasFixtures)('parses the real projects response', async () => {
    const { get, client } = createMockClient();
    const coreProjects = loadFixture('core projects.json') as Array<Record<string, unknown>>;
    get.mockResolvedValueOnce(coreProjects);

    const api = createCoreApi(client, endpoints);
    const projects = await api.getProjects();

    expect(projects.length).toBe(coreProjects.length);
    expect(projects[0]).toMatchObject({
      id: coreProjects[0].id,
      rootId: coreProjects[0].rootId,
      name: coreProjects[0].name,
      type: 'Folder',
      IsLeaf: false,
    });
  });

  it.skipIf(!hasFixtures)('parses the real folder items response', async () => {
    const { get, client } = createMockClient();
    const coreFolderItems = loadFixture('core folders-bypath qparam path projectnaam projectid.json') as Array<Record<string, unknown>>;
    get.mockResolvedValueOnce(coreFolderItems);

    const api = createCoreApi(client, endpoints);
    const items = await api.getFolderItems('root');

    expect(items.length).toBe(coreFolderItems.length);
    expect(items[0].type).toBe('Folder');
  });

  it.skipIf(!hasFixtures)('parses the real releases response', async () => {
    const { get, client } = createMockClient();
    const coreReleases = loadFixture('core projectid releases.json') as Array<Record<string, unknown>>;
    get.mockResolvedValueOnce(coreReleases);

    const api = createCoreApi(client, endpoints);
    const releases = await api.getReleases('NSsMIBkk2vM');

    expect(releases.length).toBe(coreReleases.length);
    expect(releases[0].projectId).toBe('NSsMIBkk2vM');
  });

  it.skipIf(!hasFixtures)('parses the real single release-file response', async () => {
    const { get, client } = createMockClient();
    const coreReleaseFiles = loadFixture('core releases releaseid files.json') as Record<string, unknown>;
    get.mockResolvedValueOnce(coreReleaseFiles);

    const api = createCoreApi(client, endpoints);
    const files = await api.getReleaseFiles('rel1', 'p1');

    expect(files.length).toBe(1);
    expect(files[0]).toMatchObject({
      id: coreReleaseFiles.id,
      name: coreReleaseFiles.name,
      projectId: 'p1',
    });
  });

  it.skipIf(!hasFixtures)('passes through the real search response unchanged', async () => {
    const { get, client } = createMockClient();
    const coreSearch = loadFixture('core search qparam name.json') as unknown[];
    get.mockResolvedValueOnce(coreSearch);

    const api = createCoreApi(client, endpoints);
    const result = await api.searchProject('name');

    expect(result).toEqual(coreSearch);
  });
});
