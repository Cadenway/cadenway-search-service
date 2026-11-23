import { describe, expect, it, vi } from 'vitest';

import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';

import { ClaimSearchExportPage } from './claim-search-export-page.use-case.js';

const input = {
  generationId: 'generation',
  organizationId: 'tenant',
  source: 'task' as const,
  expectedCursor: null,
  claimToken: '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01',
  claimedAt: new Date('2026-11-20T00:00:00Z'),
  claimDeadline: new Date('2026-11-20T00:01:00Z'),
};

describe('ClaimSearchExportPage', () => {
  it('returns the persisted claim outcome without taking over occupied or expired work', async () => {
    const claimExportPage = vi
      .fn()
      .mockResolvedValueOnce('claimed')
      .mockResolvedValueOnce('occupied')
      .mockResolvedValueOnce('expired')
      .mockResolvedValueOnce('stale');
    const unitOfWork: SearchRebuildExportPort = {
      run: (work) =>
        work({
          deferCheckpoint: vi.fn(),
          claimExportPage,
          recordExportPage: vi.fn(),
          recordRosterPage: vi.fn(),
        }),
    };
    const command = new ClaimSearchExportPage(unitOfWork);
    await expect(command.execute(input)).resolves.toBe('claimed');
    await expect(command.execute(input)).resolves.toBe('occupied');
    await expect(command.execute(input)).resolves.toBe('expired');
    await expect(command.execute(input)).resolves.toBe('stale');
    expect(claimExportPage).toHaveBeenCalledWith(input);
  });

  it('rejects malformed claims before opening a transaction', async () => {
    const run = vi.fn();
    const command = new ClaimSearchExportPage({
      run: () => {
        run();
        throw new Error('Unexpected transaction');
      },
    });
    await expect(command.execute({ ...input, claimToken: 'bad' })).rejects.toThrow();
    await expect(command.execute({ ...input, claimDeadline: input.claimedAt })).rejects.toThrow();
    await expect(command.execute({ ...input, expectedCursor: '' })).rejects.toThrow();
    await expect(command.execute({ ...input, organizationId: '' })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
