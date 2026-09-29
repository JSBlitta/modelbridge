// Offset/limit pagination shared by the Produuzit and Trimble clients.

import { logger } from "../logger.ts";

export interface OffsetPageOptions<T> {
  pageSize: number;
  maxPages: number;
  fetchPage: (limit: number, offset: number) => Promise<unknown>;
  unwrap: (page: unknown) => T[];
  // Return false to stop even though a full page was returned (e.g. the API
  // signals there is no `next` page).
  shouldContinue?: (page: unknown, items: T[]) => boolean;
  onCeiling?: (collected: number) => void;
}

// Collect pages until a short page (or the caller's stop condition) is reached.
// The ceiling bounds a server that ignores `offset` so the loop cannot spin
// forever.
export async function collectOffsetPages<T = unknown>(opts: OffsetPageOptions<T>): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  let pages = 0;
  while (pages < opts.maxPages) {
    pages++;
    const page = await opts.fetchPage(opts.pageSize, offset);
    const items = opts.unwrap(page);
    all.push(...items);
    if (items.length < opts.pageSize) return all;
    if (opts.shouldContinue && !opts.shouldContinue(page, items)) return all;
    offset += opts.pageSize;
  }
  if (opts.onCeiling) opts.onCeiling(all.length);
  else logger.warn(`[pagination] hit the ${opts.maxPages}-page ceiling; result is truncated`);
  return all;
}
