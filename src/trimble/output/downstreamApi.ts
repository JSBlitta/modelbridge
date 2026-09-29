export interface DownstreamSink {
  sendBatch(tableName: string, rows: unknown[]): Promise<void>;
  close?(): Promise<void>;
}

export interface HttpSinkOptions {
  url: string;
  batchSize?: number;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

export class HttpDownstreamSink implements DownstreamSink {
  private readonly batchSize: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpSinkOptions) {
    this.batchSize = options.batchSize ?? 1000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async sendBatch(tableName: string, rows: unknown[]): Promise<void> {
    for (let i = 0; i < rows.length; i += this.batchSize) {
      const chunk = rows.slice(i, i + this.batchSize);
      await this.postChunk(tableName, chunk);
    }
  }

  private async postChunk(tableName: string, rows: unknown[]): Promise<void> {
    const response = await this.fetchFn(this.options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.options.headers,
      },
      body: JSON.stringify({ tableName, rows }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Downstream API error ${response.status}: ${body}`);
    }
  }
}

export class InMemoryDownstreamSink implements DownstreamSink {
  public readonly batches: Array<{ tableName: string; rows: unknown[] }> = [];

  async sendBatch(tableName: string, rows: unknown[]): Promise<void> {
    this.batches.push({ tableName, rows });
  }
}
