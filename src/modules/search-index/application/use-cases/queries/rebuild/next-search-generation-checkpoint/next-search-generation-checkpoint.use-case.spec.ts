import { describe, expect, it, vi } from 'vitest';

import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import { NextSearchGenerationCheckpoint } from './next-search-generation-checkpoint.use-case.js';

describe('NextSearchGenerationCheckpoint', () => {
  it('returns one scoped checkpoint and preserves completion as null', async () => {
    const nextCheckpoint = vi
      .fn()
      .mockResolvedValueOnce({
        source: 'organization',
        organizationId: null,
        cursor: 'next',
        inFlightDeadline: null,
        deferred: false,
      })
      .mockResolvedValueOnce(null);
    const unitOfWork: SearchGenerationPort = {
      run: (work) =>
        work({
          findBuilding: vi.fn(),
          register: vi.fn(),
          bindIdentity: vi.fn(),
          abandon: vi.fn(),
          nextCheckpoint,
        }),
    };
    const query = new NextSearchGenerationCheckpoint(unitOfWork);
    await expect(query.execute({ generationId: 'g' })).resolves.toEqual({
      source: 'organization',
      organizationId: null,
      cursor: 'next',
      inFlightDeadline: null,
      deferred: false,
    });
    await expect(query.execute({ generationId: 'g' })).resolves.toBeNull();
    expect(nextCheckpoint).toHaveBeenCalledWith('g');
  });
});
