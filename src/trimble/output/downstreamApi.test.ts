import { describe, it, expect, vi } from 'vitest';
import { HttpDownstreamSink, InMemoryDownstreamSink } from './downstreamApi.js';

describe('HttpDownstreamSink', () => {
  it('sends rows in batches', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    const sink = new HttpDownstreamSink({ url: 'https://api.example.com/sink', batchSize: 2, fetchFn });

    await sink.sendBatch('entities', [{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [, init1] = fetchFn.mock.calls[0];
    expect(JSON.parse(init1.body)).toEqual({ tableName: 'entities', rows: [{ id: 1 }, { id: 2 }] });
  });

  it('throws on non-ok response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Server error' });
    const sink = new HttpDownstreamSink({ url: 'https://api.example.com/sink', fetchFn });

    await expect(sink.sendBatch('entities', [{ id: 1 }])).rejects.toThrow(/Downstream API error 500/);
  });
});

describe('InMemoryDownstreamSink', () => {
  it('stores batches in memory', async () => {
    const sink = new InMemoryDownstreamSink();
    await sink.sendBatch('entities', [{ id: 1 }]);

    expect(sink.batches).toEqual([{ tableName: 'entities', rows: [{ id: 1 }] }]);
  });
});
