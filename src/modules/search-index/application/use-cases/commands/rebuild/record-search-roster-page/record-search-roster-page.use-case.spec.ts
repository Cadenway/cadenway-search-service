import { describe, expect, it, vi } from 'vitest';

import type { SearchRebuildExportTransaction } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export-transaction.port.js';
import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';

import { RecordSearchRosterPage } from './record-search-roster-page.use-case.js';

describe('RecordSearchRosterPage', () => {
  it('passes the roster page into one transaction and accepts an exact retry', async () => {
    const recordRosterPage = vi
      .fn<SearchRebuildExportTransaction['recordRosterPage']>()
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('already-applied');
    const transaction = { recordRosterPage, recordExportPage: vi.fn(), claimExportPage: vi.fn() };
    const unitOfWork: SearchRebuildExportPort = { run: (work) => work(transaction) };
    const command = new RecordSearchRosterPage(unitOfWork);
    const page = {
      generationId: 'generation',
      expectedCursor: null,
      nextCursor: 'next',
      organizationIds: ['org-1', 'org-2'],
    };

    await command.execute(page);
    await command.execute(page);
    expect(recordRosterPage).toHaveBeenCalledTimes(2);
    expect(recordRosterPage).toHaveBeenCalledWith(page);
  });

  it('accepts an empty final roster and rejects a stale page', async () => {
    const recordRosterPage = vi
      .fn<SearchRebuildExportTransaction['recordRosterPage']>()
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('stale');
    const unitOfWork: SearchRebuildExportPort = {
      run: (work) =>
        work({ recordRosterPage, recordExportPage: vi.fn(), claimExportPage: vi.fn() }),
    };
    const command = new RecordSearchRosterPage(unitOfWork);
    const page = {
      generationId: 'generation',
      expectedCursor: null,
      nextCursor: null,
      organizationIds: [],
    };
    await expect(command.execute(page)).resolves.toBeUndefined();
    await expect(command.execute(page)).rejects.toThrow('Search roster checkpoint changed.');
  });

  it('rejects duplicate tenants and invalid non-progressing cursors before opening a transaction', async () => {
    const run = vi.fn();
    const command = new RecordSearchRosterPage({
      run: () => {
        run();
        throw new Error('Unexpected transaction');
      },
    });
    await expect(
      command.execute({
        generationId: 'g',
        expectedCursor: null,
        nextCursor: 'x',
        organizationIds: ['o', 'o'],
      }),
    ).rejects.toThrow();
    await expect(
      command.execute({
        generationId: 'g',
        expectedCursor: null,
        nextCursor: null,
        organizationIds: Array.from({ length: 101 }, (_, index) => String(index)),
      }),
    ).rejects.toThrow();
    await expect(
      command.execute({
        generationId: 'g',
        expectedCursor: 'x',
        nextCursor: 'x',
        organizationIds: [],
      }),
    ).rejects.toThrow();
    await expect(
      command.execute({
        generationId: 'g',
        expectedCursor: null,
        nextCursor: '',
        organizationIds: [],
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates transaction failure so a caller cannot assume the cursor was committed', async () => {
    const unitOfWork: SearchRebuildExportPort = {
      run: () => Promise.reject(new Error('rollback')),
    };
    await expect(
      new RecordSearchRosterPage(unitOfWork).execute({
        generationId: 'g',
        expectedCursor: null,
        nextCursor: null,
        organizationIds: ['o'],
      }),
    ).rejects.toThrow('rollback');
  });
});
