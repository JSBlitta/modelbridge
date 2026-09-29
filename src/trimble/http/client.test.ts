import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpClient } from './client.js';
import { InMemoryTokenStore } from '../auth/tokenStore.js';
import { OAuthClient } from '../auth/oauth.js';
import { RateLimitError, ServerError, NotFoundError } from './errors.js';

const endpoints = {
  Core: 'https://app21.connect.trimble.com/tc/api/2.0/',
  Organizer: 'https://org-api.eu-west-1.connect.trimble.com/v1/',
  Propertyset: 'https://pset-api.eu-west-1.connect.trimble.com/v1/',
  Model: 'https://model-api21.connect.trimble.com/',
  Topic: 'https://open21.connect.trimble.com/',
  'Model-feature': 'https://model-wf21.connect.trimble.com/v1/',
};

const oauthConfig = {
  clientId: 'id',
  clientSecret: 'secret',
  scope: 'openid',
  authorizeUri: 'https://id.trimble.com/oauth/authorize',
  tokenUri: 'https://id.trimble.com/oauth/token',
  redirectUri: 'https://example.com/callback',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createClient(responses: Array<() => Response>) {
  const store = new InMemoryTokenStore();
  store.setTokens({ access_token: 'token-1' });

  let callIndex = 0;
  const fetchFn = vi.fn().mockImplementation(() => {
    const makeResponse = responses[callIndex] ?? (() => jsonResponse({}));
    callIndex++;
    return Promise.resolve(makeResponse());
  });

  const oauthClient = new OAuthClient(oauthConfig, fetchFn);
  const client = new HttpClient({
    endpoints,
    tokenStore: store,
    oauthClient,
    fetchFn,
    maxRetries: 2,
  });

  return { client, fetchFn, store };
}

describe('HttpClient', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('adds the authorization header and accepts JSON', async () => {
    const { client, fetchFn } = createClient([() => jsonResponse({ id: 'p1' })]);

    const result = await client.get<{ id: string }>('https://api.example.com/projects');
    expect(result).toEqual({ id: 'p1' });

    const [, init] = fetchFn.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('retries on rate limit and then succeeds', async () => {
    const { client, fetchFn } = createClient([
      () => jsonResponse({ error: 'rate limit' }, 429),
      () => jsonResponse({ id: 'p1' }),
    ]);

    const promise = client.get<{ id: string }>('https://api.example.com/projects');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ id: 'p1' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws NotFoundError on 404', async () => {
    const { client } = createClient([() => jsonResponse({ error: 'not found' }, 404)]);

    await expect(client.get('https://api.example.com/projects/missing')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws RateLimitError after exhausting retries', async () => {
    const { client } = createClient([
      () => jsonResponse({ error: 'rate limit' }, 429),
      () => jsonResponse({ error: 'rate limit' }, 429),
    ]);

    const promise = client.get('https://api.example.com/projects').catch((err) => err);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await promise;
    expect(error).toBeInstanceOf(RateLimitError);
  });

  it('throws ServerError on 5xx after retries', async () => {
    const { client } = createClient([
      () => jsonResponse({ error: 'server error' }, 503),
      () => jsonResponse({ error: 'server error' }, 503),
    ]);

    const promise = client.get('https://api.example.com/projects').catch((err) => err);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await promise;
    expect(error).toBeInstanceOf(ServerError);
  });

  it('refreshes the token on 401 and retries', async () => {
    const store = new InMemoryTokenStore();
    store.setTokens({ access_token: 'old-token', refresh_token: 'old-refresh' });

    let callIndex = 0;
    const fetchFn = vi.fn().mockImplementation(() => {
      const responses = [
        () => jsonResponse({ error: 'unauthorized' }, 401),
        () =>
          jsonResponse({
            access_token: 'new-token',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        () => jsonResponse({ id: 'p1' }),
      ];
      const makeResponse = responses[callIndex] ?? (() => jsonResponse({}));
      callIndex++;
      return Promise.resolve(makeResponse());
    });

    const oauthClient = new OAuthClient(oauthConfig, fetchFn);
    const client = new HttpClient({
      endpoints,
      tokenStore: store,
      oauthClient,
      fetchFn,
      maxRetries: 2,
    });

    const result = await client.get<{ id: string }>('https://api.example.com/projects');
    expect(result).toEqual({ id: 'p1' });
    expect(store.getTokens()?.access_token).toBe('new-token');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
