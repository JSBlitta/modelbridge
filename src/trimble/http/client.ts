import type { RegionEndpoints } from '../types/index.js';
import type { TokenStore } from '../auth/tokenStore.js';
import { OAuthClient } from '../auth/oauth.js';
import { ClientError, HttpError, NotFoundError, RateLimitError, ServerError } from './errors.js';

export interface HttpClientOptions {
  endpoints: RegionEndpoints;
  tokenStore: TokenStore;
  oauthClient: OAuthClient;
  fetchFn?: typeof fetch;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

export interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async get<T>(url: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', url, options);
  }

  async post<T>(url: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', url, {
      ...options,
      body: JSON.stringify(body),
    });
  }

  async request<T>(method: string, url: string, options: RequestOptions = {}): Promise<T> {
    let attempt = 0;

    while (true) {
      attempt++;
      const headers = new Headers(options.headers);

      if (!options.skipAuth) {
        const token = await this.getAccessToken();
        headers.set('Authorization', `Bearer ${token}`);
      }

      if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json');
      }

      if (options.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        const response = await this.fetchFn(url, {
          ...options,
          method,
          headers,
          signal: controller.signal,
        });

        if (response.status === 401 && !options.skipAuth) {
          await this.options.oauthClient.refresh(this.options.tokenStore);
          continue;
        }

        if (response.ok) {
          const contentType = response.headers.get('Content-Type') ?? '';
          if (contentType.includes('application/json')) {
            return (await response.json()) as T;
          }
          return (await response.text()) as unknown as T;
        }

        const body = await this.parseErrorBody(response);
        const error = this.classifyError(response.status, url, body);

        if (this.shouldRetry(response.status) && attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await sleep(delay);
          continue;
        }

        throw error;
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }

        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await sleep(delay);
          continue;
        }

        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  private async getAccessToken(): Promise<string> {
    const tokens = await this.options.tokenStore.getTokens();
    if (!tokens) {
      throw new Error('No access token available. Authenticate first.');
    }
    return tokens.access_token;
  }

  private shouldRetry(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private classifyError(status: number, url: string, body: unknown): HttpError {
    if (status === 404) return new NotFoundError(url, body);
    if (status === 429) return new RateLimitError(url, body);
    if (status >= 500) return new ServerError(status, url, body);
    return new ClientError(status, url, body);
  }

  private async parseErrorBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      try {
        return await response.text();
      } catch {
        return undefined;
      }
    }
  }
}
