import { describe, expect, it, vi } from 'vitest';

import { PruneSearchGeneration } from './prune-search-generation.use-case.js';

const generation = {
  id: '01938f6e-0000-7000-8000-000000000099',
  indexUid: 'search_01938f6e000070008000000000000099',
  engineCreatedAt: '2026-11-20T19:23:41Z',
};

describe('PruneSearchGeneration', () => {
  it('keeps an uncertain deletion eligible for a later confirmed purge', async () => {
    const store = {
      claimExpiredGeneration: vi.fn().mockResolvedValue(generation),
      markGenerationPurged: vi.fn().mockResolvedValue(undefined),
    };
    const engine = {
      removeGeneration: vi.fn().mockRejectedValueOnce(new Error('Engine unavailable.')),
    };
    const prune = new PruneSearchGeneration(store, engine);
    const { signal } = new AbortController();

    await expect(prune.execute(signal)).rejects.toThrow('Engine unavailable.');
    expect(store.markGenerationPurged).not.toHaveBeenCalled();

    engine.removeGeneration.mockResolvedValue(undefined);
    await expect(prune.execute(signal)).resolves.toBeUndefined();
    expect(engine.removeGeneration).toHaveBeenLastCalledWith(
      generation.indexUid,
      generation.engineCreatedAt,
      signal,
    );
    expect(store.markGenerationPurged).toHaveBeenCalledExactlyOnceWith(generation);
  });
});
