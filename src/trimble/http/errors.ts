export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(url: string, body?: unknown) {
    super(`Not found: ${url}`, 404, url, body);
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends HttpError {
  constructor(url: string, body?: unknown) {
    super(`Rate limited: ${url}`, 429, url, body);
    this.name = 'RateLimitError';
  }
}

export class ServerError extends HttpError {
  constructor(status: number, url: string, body?: unknown) {
    super(`Server error ${status}: ${url}`, status, url, body);
    this.name = 'ServerError';
  }
}

export class ClientError extends HttpError {
  constructor(status: number, url: string, body?: unknown) {
    super(`Client error ${status}: ${url}`, status, url, body);
    this.name = 'ClientError';
  }
}
