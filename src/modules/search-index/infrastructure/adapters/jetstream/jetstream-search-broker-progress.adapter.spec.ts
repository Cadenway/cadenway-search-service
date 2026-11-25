import { describe, expect, it, vi } from 'vitest';

import { JetStreamSearchBrokerProgressAdapter } from './jetstream-search-broker-progress.adapter.js';

const createdAt = '2026-11-20T00:00:00Z';
const clear = { state: 'clear' as const, createdAt, lastSequence: 0 };
const progress = {
  stream: 'EVENTS',
  createdAt,
  firstSequence: 1,
  lastSequence: 0,
  retainedGapCount: 0,
  consumers: [],
};

describe('JetStreamSearchBrokerProgressAdapter', () => {
  it('returns the latch observation only after matching clear reads around the consumer sample', async () => {
    const connection = { consumerAdvisoryStreamState: vi.fn().mockResolvedValue(clear) };
    const consumers = { readProgress: vi.fn().mockResolvedValue(progress) };
    const adapter = new JetStreamSearchBrokerProgressAdapter(connection, consumers, ['task']);
    const signal = new AbortController().signal;
    await expect(adapter.read(signal)).resolves.toEqual({
      ...progress,
      advisoryLatch: { createdAt, lastSequence: 0 },
    });
    expect(connection.consumerAdvisoryStreamState).toHaveBeenCalledTimes(2);
    expect(connection.consumerAdvisoryStreamState).toHaveBeenCalledWith(
      'SEARCH_REBUILD_ADVISORIES',
      'EVENTS',
      ['search-service__task'],
      signal,
    );
    expect(connection.consumerAdvisoryStreamState.mock.invocationCallOrder[0]).toBeLessThan(
      consumers.readProgress.mock.invocationCallOrder[0] ?? 0,
    );
    expect(connection.consumerAdvisoryStreamState.mock.invocationCallOrder[1]).toBeGreaterThan(
      consumers.readProgress.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { state: 'clear', createdAt, lastSequence: 1 },
    { state: 'clear', createdAt: '2026-11-21T00:00:00Z', lastSequence: 0 },
    { state: 'held', createdAt, lastSequence: 1 },
    { state: 'unknown', createdAt: null, lastSequence: null },
  ])('returns no sample when the second observation differs or is uncertain: %s', async (after) => {
    const connection = {
      consumerAdvisoryStreamState: vi
        .fn()
        .mockResolvedValueOnce(clear)
        .mockResolvedValueOnce(after),
    };
    const adapter = new JetStreamSearchBrokerProgressAdapter(
      connection,
      { readProgress: vi.fn().mockResolvedValue(progress) },
      ['task'],
    );
    await expect(adapter.read()).resolves.toBeNull();
  });

  it.each(['held', 'unknown'])(
    'does not sample consumers when the first observation is %s',
    async (state) => {
      const connection = {
        consumerAdvisoryStreamState: vi
          .fn()
          .mockResolvedValue({ state, createdAt: null, lastSequence: null }),
      };
      const consumers = { readProgress: vi.fn() };
      const adapter = new JetStreamSearchBrokerProgressAdapter(connection, consumers, ['task']);
      await expect(adapter.read()).resolves.toBeNull();
      expect(consumers.readProgress).not.toHaveBeenCalled();
    },
  );
});
