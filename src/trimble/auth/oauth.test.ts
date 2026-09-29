import { describe, it, expect, vi } from 'vitest';
import { OAuthClient } from './oauth.js';
import { InMemoryTokenStore } from './tokenStore.js';

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  scope: 'openid Datatable_extractor',
  authorizeUri: 'https://id.trimble.com/oauth/authorize',
  tokenUri: 'https://id.trimble.com/oauth/token',
  redirectUri: 'https://oauth.powerbi.com/views/oauthredirect.html',
};

describe('OAuthClient', () => {
  it('builds the authorize URI with all required parameters', () => {
    const client = new OAuthClient(config);
    const start = client.startLogin('test-state');

    const url = new URL(start.loginUri);
    expect(url.origin + url.pathname).toBe(config.authorizeUri);
    expect(url.searchParams.get('scope')).toBe(config.scope);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('client_secret')).toBe(config.clientSecret);
    expect(url.searchParams.get('state')).toBe('test-state');
  });

  it('exchanges an authorization code for tokens', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const client = new OAuthClient(config, fetchFn);
    const store = new InMemoryTokenStore();
    const tokens = await client.finishLogin(
      'https://oauth.powerbi.com/views/oauthredirect.html?code=abc123&state=test',
      store,
    );

    expect(tokens.access_token).toBe('access-123');
    expect(tokens.refresh_token).toBe('refresh-456');
    expect(store.getTokens()).toEqual(tokens);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(config.tokenUri);
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('abc123');
    expect(body.get('client_id')).toBe(config.clientId);
  });

  it('refreshes the access token', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    } as unknown as Response);

    const client = new OAuthClient(config, fetchFn);
    const store = new InMemoryTokenStore();
    store.setTokens({ access_token: 'old', refresh_token: 'old-refresh' });

    const tokens = await client.refresh(store);

    expect(tokens.access_token).toBe('new-access');
    expect(store.getTokens()?.access_token).toBe('new-access');

    const body = new URLSearchParams(fetchFn.mock.calls[0][1]?.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
  });

  it('throws when the token endpoint returns an error', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', message: 'Bad credentials' }),
    } as unknown as Response);

    const client = new OAuthClient(config, fetchFn);
    const store = new InMemoryTokenStore();

    await expect(client.finishLogin(`${config.redirectUri}?code=bad`, store)).rejects.toThrow(
      /invalid_grant/,
    );
  });
});
