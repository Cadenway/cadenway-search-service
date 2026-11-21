import { describe, expect, it, vi } from 'vitest';

import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import { AbandonSearchGeneration } from './abandon-search-generation.use-case.js';

describe('AbandonSearchGeneration', () => {
  it('permits a safe retry and rejects an active or missing generation', async () => {
    const abandon = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const unitOfWork: SearchGenerationPort = {
      run: (work) =>
        work({
          findBuilding: vi.fn(),
          register: vi.fn(),
          bindIdentity: vi.fn(),
          abandon,
          nextCheckpoint: vi.fn(),
        }),
    };
    const command = new AbandonSearchGeneration(unitOfWork);
    await command.execute({ generationId: 'g' });
    await command.execute({ generationId: 'g' });
    await expect(command.execute({ generationId: 'g' })).rejects.toThrow(
      'Search generation cannot be abandoned.',
    );
  });
});
