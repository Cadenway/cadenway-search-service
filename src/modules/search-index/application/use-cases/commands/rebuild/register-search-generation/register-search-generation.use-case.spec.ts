import { describe, expect, it, vi } from 'vitest';

import type { SearchGenerationTransaction } from '../../../../ports/outbound/persistence/rebuild/search-generation-transaction.port.js';
import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import { RegisterSearchGeneration } from './register-search-generation.use-case.js';

const broker = {
  stream: 'EVENTS',
  createdAt: '2026-11-20T00:00:00Z',
  firstSequence: 1,
  lastSequence: 2,
  retainedGapCount: 0,
  consumers: [],
};
const id = '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01';
const generation = {
  id,
  indexUid: 'search_019a6f993ec07c2a8e4a2b8d41c98e01',
  engineCreatedAt: null,
  status: 'building' as const,
  brokerAtStart: broker,
};

describe('RegisterSearchGeneration', () => {
  it('registers the derived physical UID and broker observation when no candidate exists', async () => {
    const register = vi.fn<SearchGenerationTransaction['register']>().mockResolvedValue(generation);
    const transaction: SearchGenerationTransaction = {
      findBuilding: vi.fn().mockResolvedValue(null),
      register,
      bindIdentity: vi.fn(),
      abandon: vi.fn(),
      nextCheckpoint: vi.fn(),
    };
    const unitOfWork: SearchGenerationPort = { run: (work) => work(transaction) };
    const result = await new RegisterSearchGeneration(unitOfWork).execute({
      generationId: id.toUpperCase(),
      brokerAtStart: broker,
    });
    expect(result).toEqual({ generation, newlyRegistered: true });
    expect(register).toHaveBeenCalledWith({
      id,
      indexUid: generation.indexUid,
      brokerAtStart: broker,
    });
  });

  it('does not submit a second candidate when a prior registration is found', async () => {
    const register = vi.fn();
    const transaction: SearchGenerationTransaction = {
      findBuilding: vi.fn().mockResolvedValue(generation),
      register,
      bindIdentity: vi.fn(),
      abandon: vi.fn(),
      nextCheckpoint: vi.fn(),
    };
    const unitOfWork: SearchGenerationPort = { run: (work) => work(transaction) };
    const result = await new RegisterSearchGeneration(unitOfWork).execute({
      generationId: id,
      brokerAtStart: broker,
    });
    expect(result).toEqual({ generation, newlyRegistered: false });
    expect(register).not.toHaveBeenCalled();
  });

  it('rejects an invalid candidate identifier before opening a transaction', async () => {
    const run = vi.fn();
    const unitOfWork: SearchGenerationPort = {
      run: () => {
        run();
        throw new Error('unexpected');
      },
    };
    await expect(
      new RegisterSearchGeneration(unitOfWork).execute({
        generationId: 'bad',
        brokerAtStart: broker,
      }),
    ).rejects.toThrow('Invalid search generation identifier.');
    expect(run).not.toHaveBeenCalled();
  });
});
