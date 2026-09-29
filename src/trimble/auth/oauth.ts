import type { Config } from '../config/config.js';
import type { TokenStore } from './tokenStore.js';
import type { Tokens } from '../types/index.js';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  scope: string;
  authorizeUri: string;
  tokenUri: string;
  redirectUri: string;
}

export interface LoginStartResult {
  loginUri: string;
  callbackUri: string;
  windowHeight: number;
  windowWidth: number;
}

export function createOAuthConfig(config: Config): OAuthConfig {
  return {
    clientId: config.trimbleConnectAuthorization.clientId,
    clientSecret: config.trimbleConnectAuthorization.clientSecret,
    scope: config.trimbleConnectAuthorization.scope,
    authorizeUri: config.trimbleConnectURLs.authorizeUri,
    tokenUri: config.trimbleConnectURLs.tokenUri,
    redirectUri: config.trimbleConnectURLs.redirectUri,
  };
}

export class OAuthClient {
  constructor(
    private readonly config: OAuthConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  startLogin(state: string): LoginStartResult {
    const params = new URLSearchParams({
      scope: this.config.scope,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      state,
    });

    return {
      loginUri: `${this.config.authorizeUri}?${params.toString()}`,
      callbackUri: this.config.redirectUri,
      windowHeight: 1000,
      windowWidth: 800,
    };
  }

  async finishLogin(callbackUri: string, store: TokenStore): Promise<Tokens> {
    const url = new URL(callbackUri);
    const code = url.searchParams.get('code');
    if (!code) {
      throw new Error('Authorization code not found in callback URI');
    }
    const tokens = await this.exchangeCode(code);
    await store.setTokens(tokens);
    return tokens;
  }

  async refresh(store: TokenStore): Promise<Tokens> {
    const tokens = await store.getTokens();
    if (!tokens?.refresh_token) {
      throw new Error('No refresh token available');
    }
    const refreshed = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    await store.setTokens(refreshed);
    return refreshed;
  }

  private async exchangeCode(code: string): Promise<Tokens> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
    });
  }

  private async tokenRequest(payload: Record<string, string>): Promise<Tokens> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      ...payload,
    });

    const response = await this.fetchFn(this.config.tokenUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(
        `Token request failed: ${response.status} ${String(data.error ?? '')} ${String(data.message ?? '')}`.trim(),
      );
    }

    if (data.error) {
      throw new Error(`OAuth error: ${String(data.error)} ${String(data.message ?? '')}`.trim());
    }

    const tokens: Tokens = {
      access_token: String(data.access_token),
      refresh_token: data.refresh_token ? String(data.refresh_token) : undefined,
      expires_in: data.expires_in ? Number(data.expires_in) : undefined,
      token_type: data.token_type ? String(data.token_type) : undefined,
    };

    return tokens;
  }
}
