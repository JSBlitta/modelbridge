import type { HttpClient } from '../http/client.js';
import type { RegionEndpoints } from '../types/index.js';
import { Pagination } from '../http/pagination.js';
import { NotFoundError } from '../http/errors.js';

export interface ProjectTree {
  forestId: string;
  treeId: string;
  treeV: number;
  treeName: string;
}

export interface ProjectNode {
  forestId: string;
  treeId: string;
  nodeId: string;
  nodeV: number;
  nodeName: string;
  entitiesCount: number;
  metadata?: Record<string, unknown>;
}

export interface ProjectNodeRef {
  nodeId: string;
  treeId: string;
  forestId?: string;
}

export interface ProjectNodeOptions {
  includeMetadata?: boolean;
}

interface RawProjectNode {
  forestId: string;
  treeId: string;
  id: string;
  v: number;
  name: string;
  count: number;
  metadata?: Record<string, unknown>;
}

interface OrganizerNodeIdentity {
  forestId: string;
  treeId: string;
  nodeId: string;
}

interface OrganizerBatchGetResponse {
  unprocessed?: { nodes?: OrganizerNodeIdentity[] };
  responses?: { nodes?: RawProjectNode[] };
  errors?: { nodes?: Array<{ item: OrganizerNodeIdentity; code: string; message: string }> };
}

export interface OrganizerApi {
  getProjectTrees(projectId: string): Promise<ProjectTree[]>;
  getProjectNodes(projectId: string, treeId: string, options?: ProjectNodeOptions): Promise<ProjectNode[]>;
  getProjectNodeLinks(projectId: string, treeId: string, nodeId: string): Promise<string[]>;
  getProjectLibraryIds(projectId: string): Promise<string[]>;
  batchGetNodes(projectId: string, nodes: ProjectNodeRef[], options?: ProjectNodeOptions): Promise<ProjectNode[]>;
}

const BATCH_GET_CHUNK_SIZE = 100;
const BATCH_GET_MAX_ATTEMPTS = 3;

export function createOrganizerApi(client: HttpClient, endpoints: RegionEndpoints): OrganizerApi {
  const pagination = new Pagination(client);

  return {
    async getProjectTrees(projectId: string): Promise<ProjectTree[]> {
      const url = `${endpoints.Organizer}forests/${encodeURIComponent(projectId)}/trees`;
      try {
        const response = await client.get<{ items: Array<{ forestId: string; id: string; v: number; name: string }> }>(url);
        return (response.items ?? []).map((item) => ({
          forestId: item.forestId,
          treeId: item.id,
          treeV: item.v,
          treeName: decodeUrl(item.name),
        }));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return [];
        }
        throw error;
      }
    },

    async getProjectNodes(projectId: string, treeId: string, options: ProjectNodeOptions = {}): Promise<ProjectNode[]> {
      const url = `${endpoints.Organizer}forests/${encodeURIComponent(projectId)}/trees/${encodeURIComponent(treeId)}/nodes`;
      const query = options.includeMetadata ? 'nolinks=true&fields=metadata' : 'nolinks=true';
      const items = await pagination.fetchAllPages<RawProjectNode>(url, 250, query);

      return items.map(mapProjectNode);
    },

    async getProjectNodeLinks(projectId: string, treeId: string, nodeId: string): Promise<string[]> {
      const url = `${endpoints.Organizer}forests/${encodeURIComponent(projectId)}/trees/${encodeURIComponent(treeId)}/nodes/${encodeURIComponent(nodeId)}/links`;
      const links = await client.get<string[]>(url);
      return links.map(removeFrnPrefix);
    },

    async getProjectLibraryIds(projectId: string): Promise<string[]> {
      const url = `${endpoints.Organizer}forests/project:${encodeURIComponent(projectId)}:data/trees/ProjectContext/nodes/PSetLibs`;
      try {
        const response = await client.get<{ links: string[] }>(url);
        return (response.links ?? []).map(removeFrnPrefix);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return [];
        }
        throw error;
      }
    },

    async batchGetNodes(projectId: string, nodes: ProjectNodeRef[], options: ProjectNodeOptions = {}): Promise<ProjectNode[]> {
      const seen = new Set<string>();
      const uniqueNodes: OrganizerNodeIdentity[] = [];
      for (const node of nodes) {
        const identity: OrganizerNodeIdentity = {
          forestId: node.forestId ?? projectId,
          treeId: node.treeId,
          nodeId: node.nodeId,
        };
        const key = `${identity.forestId}|${identity.treeId}|${identity.nodeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueNodes.push(identity);
      }

      const query = options.includeMetadata ? 'nolinks=true&fields=metadata' : 'nolinks=true';
      const url = `${endpoints.Organizer}batch-get?${query}`;
      const collected: RawProjectNode[] = [];

      for (let i = 0; i < uniqueNodes.length; i += BATCH_GET_CHUNK_SIZE) {
        let pending = uniqueNodes.slice(i, i + BATCH_GET_CHUNK_SIZE);

        for (let attempt = 0; attempt < BATCH_GET_MAX_ATTEMPTS && pending.length > 0; attempt++) {
          const response = await client.post<OrganizerBatchGetResponse>(url, { nodes: pending });
          collected.push(...(response.responses?.nodes ?? []));
          for (const error of response.errors?.nodes ?? []) {
            console.warn(`Organizer node fetch failed for ${error.item.nodeId}: ${error.code} ${error.message}`);
          }
          pending = response.unprocessed?.nodes ?? [];
        }

        if (pending.length > 0) {
          console.warn(`Organizer batch-get left ${pending.length} nodes unprocessed`);
        }
      }

      return collected.map(mapProjectNode);
    },
  };
}

function mapProjectNode(item: RawProjectNode): ProjectNode {
  return {
    forestId: item.forestId,
    treeId: item.treeId,
    nodeId: item.id,
    nodeV: item.v,
    nodeName: decodeUrl(item.name),
    entitiesCount: item.count,
    ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
  };
}

function decodeUrl(data: string): string {
  try {
    return decodeURIComponent(data);
  } catch {
    return data;
  }
}

function removeFrnPrefix(inputText: string): string {
  if (!inputText.startsWith('frn:')) return inputText;
  const decoded = decodeUrl(inputText);
  const parts = decoded.split(':');
  // Resource ids may themselves contain ':' segments (e.g. frn:lib:{libId}:{projectId}:{uuid})
  return parts.length >= 3 ? parts.slice(2).join(':') : inputText;
}
