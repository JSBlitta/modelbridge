import type { HttpClient } from '../http/client.js';
import type { RegionEndpoints } from '../types/index.js';

export interface Project {
  id: string;
  rootId: string;
  name: string;
  description?: string;
  type: 'Folder';
  IsLeaf: false;
}

export interface FolderItem {
  id: string;
  name: string;
  type: 'Folder' | 'File';
  versionId?: string;
  projectId?: string;
  parentId?: string;
}

export interface FileVersion {
  id: string;
  name: string;
  type: string;
  versionId: string;
  projectId: string;
  path?: string;
  createdOn?: string;
  modifiedOn?: string;
  revision?: string;
}

export interface Release {
  id: string;
  name: string;
  status: string;
  projectId: string;
  dueDate?: string;
  notes?: string;
  modifiedOn?: string;
  createdOn?: string;
}

export interface ReleaseFile {
  id: string;
  name: string;
  type: string;
  versionId: string;
  revision?: string;
  modifiedOn?: string;
  modifiedBy?: string;
  projectId: string;
}

export interface CoreApi {
  getProjects(): Promise<Project[]>;
  searchProject(query: string, type?: string): Promise<unknown[]>;
  getFolderItems(folderId: string): Promise<FolderItem[]>;
  getFileVersions(fileId: string): Promise<FileVersion[]>;
  getReleases(projectId: string): Promise<Release[]>;
  getReleaseFiles(releaseId: string, projectId: string): Promise<ReleaseFile[]>;
}

export function createCoreApi(client: HttpClient, endpoints: RegionEndpoints): CoreApi {
  return {
    async getProjects(): Promise<Project[]> {
      const url = new URL(`${endpoints.Core}projects`);
      url.searchParams.set('fullyLoaded', 'false');
      url.searchParams.set('sort', '-name');

      const projects = await client.get<
        Array<{
          id: string;
          rootId: string;
          name: string;
          description?: string;
        }>
      >(url.toString());

      return projects.map((project) => ({
        ...project,
        type: 'Folder' as const,
        IsLeaf: false as const,
      }));
    },

    async searchProject(query: string, type = 'PROJECT'): Promise<unknown[]> {
      const url = `${endpoints.Core}search?query=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`;
      return client.get<unknown[]>(url);
    },

    async getFolderItems(folderId: string): Promise<FolderItem[]> {
      const url = `${endpoints.Core}folders/${encodeURIComponent(folderId)}/items`;
      const items = await client.get<
        Array<{
          id: string;
          name: string;
          type: string;
          versionId?: string;
          projectId?: string;
          parentId?: string;
        }>
      >(url);

      return items.map((item) => ({
        id: item.id,
        name: item.name,
        type: properCase(item.type) as 'Folder' | 'File',
        versionId: item.versionId,
        projectId: item.projectId,
        parentId: item.parentId,
      }));
    },

    async getFileVersions(fileId: string): Promise<FileVersion[]> {
      const url = `${endpoints.Core}files/${encodeURIComponent(fileId)}/versions`;
      const versions = await client.get<
        Array<{
          id: string;
          name: string;
          type: string;
          versionId: string;
          projectId: string;
          path?: string;
          createdOn?: string;
          modifiedOn?: string;
          revision?: string;
        }>
      >(url);

      return versions.map((version) => ({
        ...version,
        name: version.revision
          ? `${version.name} Rev. ${version.revision}`
          : version.name,
      }));
    },

    async getReleases(projectId: string): Promise<Release[]> {
      const url = `${endpoints.Core}releases?projectId=${encodeURIComponent(projectId)}`;
      return client.get<Release[]>(url);
    },

    async getReleaseFiles(releaseId: string, projectId: string): Promise<ReleaseFile[]> {
      const url = `${endpoints.Core}releases/${encodeURIComponent(releaseId)}/files`;
      const response = await client.get<
        ReleaseFile | ReleaseFile[]
      >(url);

      const files = Array.isArray(response) ? response : [response];
      return files.map((file) => ({
        ...file,
        projectId,
      }));
    },
  };
}

function properCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
