import type { CoreApi, FolderItem } from '../apis/core.js';

export interface FolderWalkerOptions {
  /** If true, recurse into sub-folders. Default: true. */
  recursive?: boolean;
}

export async function* walkFolders(
  coreApi: CoreApi,
  rootFolderId: string,
  options: FolderWalkerOptions = {},
): AsyncGenerator<FolderItem, void, unknown> {
  const { recursive = true } = options;
  const queue: string[] = [rootFolderId];

  while (queue.length > 0) {
    const folderId = queue.shift()!;
    const items = await coreApi.getFolderItems(folderId);

    for (const item of items) {
      yield item;

      if (recursive && item.type === 'Folder') {
        queue.push(item.id);
      }
    }
  }
}
