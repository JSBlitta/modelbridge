import { readFile, writeFile } from 'node:fs/promises';
import type { TokenStore } from './tokenStore.js';
import type { Tokens } from '../types/index.js';

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async getTokens(): Promise<Tokens | null> {
    try {
      const content = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(content) as Tokens;
      return parsed;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async setTokens(tokens: Tokens): Promise<void> {
    await writeFile(this.path, JSON.stringify(tokens, null, 2));
  }

  async clearTokens(): Promise<void> {
    await writeFile(this.path, JSON.stringify({}, null, 2));
  }
}
