import { readFile, writeFile } from 'node:fs/promises';

export interface CachedProject {
  projectId: string;
  name: string;
  region: string;
  rootId?: string;
  lastSeenAt: string;
}

export interface CachedModel {
  modelId: string;
  projectId: string;
  name: string;
  versionId?: string;
  lastSeenAt: string;
}

export interface CachedRelease {
  releaseId: string;
  projectId: string;
  name: string;
  lastSeenAt: string;
}

export interface CachedLibrary {
  libraryId: string;
  projectId: string;
  modelId?: string;
  lastSeenAt: string;
}

export interface CacheData {
  projects: CachedProject[];
  models: CachedModel[];
  releases: CachedRelease[];
  libraries: CachedLibrary[];
}

export class Cache {
  private data: CacheData = {
    projects: [],
    models: [],
    releases: [],
    libraries: [],
  };

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(content) as Partial<CacheData>;
      this.data = {
        projects: parsed.projects ?? [],
        models: parsed.models ?? [],
        releases: parsed.releases ?? [],
        libraries: parsed.libraries ?? [],
      };
    } catch {
      this.data = { projects: [], models: [], releases: [], libraries: [] };
    }
  }

  async save(): Promise<void> {
    await writeFile(this.path, JSON.stringify(this.data, null, 2));
  }

  getProjects(): CachedProject[] {
    return this.data.projects;
  }

  getModels(projectId?: string): CachedModel[] {
    if (!projectId) return this.data.models;
    return this.data.models.filter((m) => m.projectId === projectId);
  }

  getReleases(projectId?: string): CachedRelease[] {
    if (!projectId) return this.data.releases;
    return this.data.releases.filter((r) => r.projectId === projectId);
  }

  getLibraries(projectId?: string, modelId?: string): CachedLibrary[] {
    return this.data.libraries.filter(
      (l) =>
        (!projectId || l.projectId === projectId) &&
        (!modelId || l.modelId === modelId),
    );
  }

  upsertProject(project: Omit<CachedProject, 'lastSeenAt'>): void {
    const existing = this.data.projects.find((p) => p.projectId === project.projectId);
    const entry: CachedProject = { ...project, lastSeenAt: new Date().toISOString() };
    if (existing) {
      Object.assign(existing, entry);
    } else {
      this.data.projects.push(entry);
    }
  }

  upsertModel(model: Omit<CachedModel, 'lastSeenAt'>): void {
    const existing = this.data.models.find((m) => m.modelId === model.modelId);
    const entry: CachedModel = { ...model, lastSeenAt: new Date().toISOString() };
    if (existing) {
      Object.assign(existing, entry);
    } else {
      this.data.models.push(entry);
    }
  }

  upsertRelease(release: Omit<CachedRelease, 'lastSeenAt'>): void {
    const existing = this.data.releases.find((r) => r.releaseId === release.releaseId);
    const entry: CachedRelease = { ...release, lastSeenAt: new Date().toISOString() };
    if (existing) {
      Object.assign(existing, entry);
    } else {
      this.data.releases.push(entry);
    }
  }

  upsertLibrary(library: Omit<CachedLibrary, 'lastSeenAt'>): void {
    const existing = this.data.libraries.find(
      (l) => l.libraryId === library.libraryId && l.projectId === library.projectId && l.modelId === library.modelId,
    );
    const entry: CachedLibrary = { ...library, lastSeenAt: new Date().toISOString() };
    if (existing) {
      Object.assign(existing, entry);
    } else {
      this.data.libraries.push(entry);
    }
  }
}
