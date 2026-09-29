import type { Config } from './config/config.js';
import { getRegionEndpoints } from './config/regions.js';
import { OAuthClient, createOAuthConfig } from './auth/oauth.js';
import { InMemoryTokenStore, type TokenStore } from './auth/tokenStore.js';
import { HttpClient } from './http/client.js';
import { createCoreApi } from './apis/core.js';
import { createModelApi } from './apis/model.js';
import { createOrganizerApi } from './apis/organizer.js';
import { createPropertysetApi } from './apis/propertyset.js';
import { checkApis } from './pipeline/apiCheck.js';
import { getFullEntityTable } from './pipeline/fullEntityTable.js';
import { walkFolders } from './pipeline/folderWalker.js';
import { Cache } from './cache/cache.js';
import type { DownstreamSink } from './output/downstreamApi.js';

export interface RunOptions {
  region: string;
  projectId?: string;
  modelId?: string;
  versionId?: string;
}

export interface RunContext {
  config: Config;
  tokenStore?: TokenStore;
  cache?: Cache;
  sink?: DownstreamSink;
  fetchFn?: typeof fetch;
  skipPropertyset?: boolean;
}

export interface RunResult {
  projectId: string;
  modelId: string;
  versionId?: string;
  entityCount: number;
}

export async function run(options: RunOptions, context: RunContext): Promise<RunResult> {
  const config = context.config;
  const endpoints = getRegionEndpoints(options.region);

  const tokenStore = context.tokenStore ?? new InMemoryTokenStore();
  const oauthClient = new OAuthClient(createOAuthConfig(config), context.fetchFn);
  const httpClient = new HttpClient({
    endpoints,
    tokenStore,
    oauthClient,
    fetchFn: context.fetchFn,
  });

  const coreApi = createCoreApi(httpClient, endpoints);
  const modelApi = createModelApi(httpClient, endpoints, config.connectorSettings.batchChunkSize);
  const organizerApi = createOrganizerApi(httpClient, endpoints);
  const propertysetApi = createPropertysetApi(httpClient, endpoints);

  const cache = context.cache;
  if (cache) await cache.load();

  let projectId = options.projectId;
  let modelId = options.modelId;
  let versionId = options.versionId;

  if (!projectId) {
    const projects = await coreApi.getProjects();
    if (projects.length === 0) {
      throw new Error('No projects found');
    }
    projectId = projects[0]?.id;

    for (const project of projects) {
      cache?.upsertProject({
        projectId: project.id,
        name: project.name,
        region: options.region,
        rootId: project.rootId,
      });
    }
  }

  if (!projectId) {
    throw new Error('Unable to determine project ID');
  }

  if (!modelId || !versionId) {
    const modelFile = await findFirstModelFile(coreApi, projectId);
    modelId = modelFile.modelId;
    versionId = modelFile.versionId;

    cache?.upsertModel({
      modelId,
      projectId,
      name: modelFile.name,
      versionId,
    });
  }

  const checks = await checkApis(organizerApi, projectId);

  if (checks.propertySet && Array.isArray(checks.propertySet) && !context.skipPropertyset) {
    for (const libraryId of checks.propertySet) {
      cache?.upsertLibrary({ libraryId, projectId, modelId });
    }
  }

  const libIds = context.skipPropertyset ? false : checks.propertySet;

  const rows = await getFullEntityTable(
    modelApi,
    propertysetApi,
    { id: modelId, projectId, versionId },
    libIds,
    {
      propertysetToKeep: config.connectorSettings.propertysetToKeep,
      propertySetsDiscard: config.connectorSettings.propertySetsDiscard,
      entityTextFilter: config.connectorSettings.entityTextFilter,
    },
  );

  if (context.sink && rows.length > 0) {
    await context.sink.sendBatch('entities', rows);
  }

  if (cache) await cache.save();

  return {
    projectId,
    modelId,
    versionId,
    entityCount: rows.length,
  };
}

async function findFirstModelFile(
  coreApi: ReturnType<typeof createCoreApi>,
  projectId: string,
): Promise<{ modelId: string; versionId: string; name: string }> {
  const projects = await coreApi.getProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  for await (const item of walkFolders(coreApi, project.rootId, { recursive: true })) {
    if (item.type === 'File' && isValidModelFileType(item.name)) {
      const versions = await coreApi.getFileVersions(item.id);
      const version = pickLatestVersion(versions);
      if (version) {
        return {
          modelId: version.id,
          versionId: version.versionId,
          name: item.name,
        };
      }
    }
  }

  throw new Error(`No valid model files found in project ${projectId}`);
}

function isValidModelFileType(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.ifc') || lower.endsWith('.ifczip') || lower.endsWith('.trb');
}

function pickLatestVersion(versions: Array<{ id: string; modifiedOn?: string; createdOn?: string; versionId: string }>) {
  if (versions.length === 0) return undefined;
  return [...versions].sort((a, b) => {
    const aDate = new Date(a.modifiedOn ?? a.createdOn ?? 0).getTime();
    const bDate = new Date(b.modifiedOn ?? b.createdOn ?? 0).getTime();
    return bDate - aDate;
  })[0];
}
