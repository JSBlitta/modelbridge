import { describe, it, expect, beforeEach } from 'vitest';
import { Cache } from './cache.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Cache', () => {
  let cachePath: string;
  let cache: Cache;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trimble-cache-'));
    cachePath = join(dir, 'cache.json');
    cache = new Cache(cachePath);
  });

  it('persists and loads projects', async () => {
    cache.upsertProject({ projectId: 'p1', name: 'Project 1', region: 'Europe' });
    await cache.save();

    const loaded = new Cache(cachePath);
    await loaded.load();

    expect(loaded.getProjects()).toHaveLength(1);
    expect(loaded.getProjects()[0]).toMatchObject({ projectId: 'p1', name: 'Project 1' });
  });

  it('filters models by project', () => {
    cache.upsertModel({ modelId: 'm1', projectId: 'p1', name: 'Model 1' });
    cache.upsertModel({ modelId: 'm2', projectId: 'p2', name: 'Model 2' });

    expect(cache.getModels('p1').map((m) => m.modelId)).toEqual(['m1']);
  });

  it('updates existing entries instead of duplicating', () => {
    cache.upsertProject({ projectId: 'p1', name: 'Old', region: 'Europe' });
    cache.upsertProject({ projectId: 'p1', name: 'New', region: 'Europe' });

    expect(cache.getProjects()).toHaveLength(1);
    expect(cache.getProjects()[0].name).toBe('New');
  });
});
