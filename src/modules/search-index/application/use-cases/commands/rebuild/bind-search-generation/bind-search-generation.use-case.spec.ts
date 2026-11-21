import { describe, expect, it, vi } from 'vitest';

import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import { BindSearchGeneration } from './bind-search-generation.use-case.js';

describe('BindSearchGeneration', () => {
  it('records a confirmed physical identity and refuses changed identities', async () => {
    const bindIdentity = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const unitOfWork: SearchGenerationPort = {
      run: (work) =>
        work({
          findBuilding: vi.fn(),
          register: vi.fn(),
          bindIdentity,
          abandon: vi.fn(),
          nextCheckpoint: vi.fn(),
        }),
    };
    const command = new BindSearchGeneration(unitOfWork);
    const input = { generationId: 'generation', engineCreatedAt: '2026-11-20T00:00:00Z' };
    await command.execute(input);
    await command.execute(input);
    await expect(command.execute(input)).rejects.toThrow('Search generation identity changed.');
    expect(bindIdentity).toHaveBeenCalledWith(input.generationId, input.engineCreatedAt);
  });
});
