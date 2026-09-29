import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore } from './fileTokenStore.js';

describe('FileTokenStore', () => {
  let tempDir: string;
  let store: FileTokenStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'token-store-'));
    store = new FileTokenStore(join(tempDir, 'tokens.json'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no tokens are stored', async () => {
    const tokens = await store.getTokens();
    expect(tokens).toBeNull();
  });

  it('round-trips tokens', async () => {
    const tokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    };

    await store.setTokens(tokens);
    const retrieved = await store.getTokens();

    expect(retrieved).toEqual(tokens);
  });

  it('clears tokens', async () => {
    await store.setTokens({ access_token: 'access' });
    await store.clearTokens();
    const retrieved = await store.getTokens();
    expect(retrieved).toEqual({});
  });
});
