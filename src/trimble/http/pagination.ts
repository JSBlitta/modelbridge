import type { HttpClient } from './client.js';

export interface PaginatedResponse<T> {
  items: T[];
  offsetNext?: number;
  total?: number;
  next?: string;
}

export interface BatchResponse<T> {
  responses?: {
    entities?: T[];
    errors?: unknown[];
  };
}

export class Pagination {
  constructor(private readonly client: HttpClient) {}

  async fetchAllPages<T>(baseUrl: string, pageSize: number, queryString?: string): Promise<T[]> {
    const results: T[] = [];
    let offset = 0;
    let nextUrl: string | undefined;

    while (true) {
      let url: string;
      if (nextUrl) {
        url = nextUrl;
      } else {
        const urlObj = new URL(baseUrl);
        urlObj.searchParams.set('top', String(pageSize));
        if (offset > 0) {
          urlObj.searchParams.set('offset', String(offset));
        }
        if (queryString) {
          const extra = new URLSearchParams(queryString.replace(/^\?/, ''));
          for (const [key, value] of extra) {
            if (!urlObj.searchParams.has(key)) {
              urlObj.searchParams.set(key, value);
            }
          }
        }
        url = urlObj.toString();
      }

      const page = await this.client.get<PaginatedResponse<T>>(url);
      results.push(...page.items);

      if (page.next) {
        nextUrl = page.next;
        offset = page.offsetNext ?? offset + page.items.length;
      } else if (page.offsetNext !== undefined && page.offsetNext > offset) {
        nextUrl = undefined;
        offset = page.offsetNext;
      } else {
        break;
      }

      if (page.total !== undefined && results.length >= page.total) {
        break;
      }

      if (page.items.length < pageSize) {
        break;
      }
    }

    return results;
  }

  async batchPost<T>(url: string, body: unknown): Promise<T> {
    return this.client.post<T>(url, body);
  }
}
