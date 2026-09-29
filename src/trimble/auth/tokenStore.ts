import type { Tokens } from '../types/index.js';

export interface TokenStore {
  getTokens(): Promise<Tokens | null> | Tokens | null;
  setTokens(tokens: Tokens): Promise<void> | void;
  clearTokens(): Promise<void> | void;
}

export class InMemoryTokenStore implements TokenStore {
  private tokens: Tokens | null = null;

  getTokens(): Tokens | null {
    return this.tokens;
  }

  setTokens(tokens: Tokens): void {
    this.tokens = tokens;
  }

  clearTokens(): void {
    this.tokens = null;
  }
}
