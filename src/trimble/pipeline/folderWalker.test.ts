import { describe, it, expect, vi } from 'vitest';
import { walkFolders } from './folderWalker.js';
import type { CoreApi, FolderItem } from '../apis/core.js';

function createMockCoreApi(itemsByFolder: Record<string, FolderItem[]>) {
  return {
    getFolderItems: vi.fn(async (folderId: string) => itemsByFolder[folderId] ?? []),
  } as unknown as CoreApi;
}

describe('walkFolders', () => {
  it('yields items from a single folder', async () => {
    const coreApi = createMockCoreApi({
      root: [
        { id: 'f1', name: 'model.ifc', type: 'File' },
      ],
    });

    const results: FolderItem[] = [];
    for await (const item of walkFolders(coreApi, 'root')) {
      results.push(item);
    }

    expect(results).toEqual([{ id: 'f1', name: 'model.ifc', type: 'File' }]);
  });

  it('recursively walks nested folders', async () => {
    const coreApi = createMockCoreApi({
      root: [
        { id: 'folder-1', name: 'Models', type: 'Folder' },
        { id: 'file-1', name: 'readme.txt', type: 'File' },
      ],
      'folder-1': [
        { id: 'file-2', name: 'model.ifc', type: 'File' },
      ],
    });

    const results: FolderItem[] = [];
    for await (const item of walkFolders(coreApi, 'root')) {
      results.push(item);
    }

    expect(results.map((r) => r.id)).toEqual(['folder-1', 'file-1', 'file-2']);
  });

  it('does not recurse when recursive is false', async () => {
    const coreApi = createMockCoreApi({
      root: [
        { id: 'folder-1', name: 'Models', type: 'Folder' },
      ],
      'folder-1': [
        { id: 'file-2', name: 'model.ifc', type: 'File' },
      ],
    });

    const results: FolderItem[] = [];
    for await (const item of walkFolders(coreApi, 'root', { recursive: false })) {
      results.push(item);
    }

    expect(results.map((r) => r.id)).toEqual(['folder-1']);
    expect(coreApi.getFolderItems).toHaveBeenCalledTimes(1);
  });
});
