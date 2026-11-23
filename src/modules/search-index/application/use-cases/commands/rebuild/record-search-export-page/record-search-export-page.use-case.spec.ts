import { describe, expect, it, vi } from 'vitest';

import type { SearchRebuildExportTransaction } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export-transaction.port.js';
import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';

import { RecordSearchExportPage } from './record-search-export-page.use-case.js';

describe('RecordSearchExportPage', () => {
  it('records a tenant final page and tolerates its already committed replay', async () => {
    const recordExportPage = vi
      .fn<SearchRebuildExportTransaction['recordExportPage']>()
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('already-applied')
      .mockResolvedValueOnce('stale');
    const unitOfWork: SearchRebuildExportPort = {
      run: (work) =>
        work({
          deferCheckpoint: vi.fn(),
          recordExportPage,
          recordRosterPage: vi.fn(),
          claimExportPage: vi.fn(),
        }),
    };
    const command = new RecordSearchExportPage(unitOfWork);
    const page = {
      generationId: 'g',
      organizationId: 'o',
      source: 'task' as const,
      claimToken: '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01',
      expectedCursor: 'prior',
      nextCursor: null,
    };
    await command.execute(page);
    await command.execute(page);
    await expect(command.execute(page)).rejects.toThrow('Search source checkpoint changed.');
    expect(recordExportPage).toHaveBeenCalledWith(page);
  });

  it('rejects an empty tenant, non-progressing cursor and unknown source before writing', async () => {
    const run = vi.fn();
    const command = new RecordSearchExportPage({
      run: () => {
        run();
        throw new Error('Unexpected transaction');
      },
    });
    const page = {
      generationId: 'g',
      organizationId: 'o',
      source: 'task' as const,
      claimToken: '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01',
      expectedCursor: 'prior',
      nextCursor: 'next',
    };
    await expect(command.execute({ ...page, organizationId: '' })).rejects.toThrow();
    await expect(command.execute({ ...page, claimToken: '' })).rejects.toThrow();
    await expect(command.execute({ ...page, nextCursor: 'prior' })).rejects.toThrow();
    await expect(command.execute({ ...page, source: 'organization' as 'task' })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
