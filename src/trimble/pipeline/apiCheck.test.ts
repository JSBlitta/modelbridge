import { describe, it, expect, vi } from 'vitest';
import { checkApis } from './apiCheck.js';
import type { OrganizerApi } from '../apis/organizer.js';

function createMockOrganizerApi(trees: unknown[], libIds: string[]) {
  return {
    getProjectTrees: vi.fn(async () => trees),
    getProjectLibraryIds: vi.fn(async () => libIds),
  } as unknown as OrganizerApi;
}

describe('checkApis', () => {
  it('returns trees and libIds when both exist', async () => {
    const api = createMockOrganizerApi([{ treeId: 't1' }], ['lib-1']);
    const checks = await checkApis(api, 'p1');

    expect(checks.organizer).toEqual([{ treeId: 't1' }]);
    expect(checks.propertySet).toEqual(['lib-1']);
  });

  it('returns false for empty trees and libIds', async () => {
    const api = createMockOrganizerApi([], []);
    const checks = await checkApis(api, 'p1');

    expect(checks.organizer).toBe(false);
    expect(checks.propertySet).toBe(false);
  });
});
