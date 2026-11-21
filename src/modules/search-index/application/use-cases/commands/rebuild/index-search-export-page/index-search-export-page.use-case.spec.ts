import { describe, expect, it, vi } from 'vitest';

import type { SearchSystemAuthority } from '../../../../ports/outbound/http/authority/search-system-authority.port.js';
import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';
import type { SearchProjectionIndexerPort } from '../../../../ports/outbound/search/rebuild/search-projection-indexer.port.js';
import { ClaimSearchExportPage } from '../claim-search-export-page/claim-search-export-page.use-case.js';
import { RecordSearchExportPage } from '../record-search-export-page/record-search-export-page.use-case.js';
import { RecordSearchRosterPage } from '../record-search-roster-page/record-search-roster-page.use-case.js';

import { IndexSearchExportPage } from './index-search-export-page.use-case.js';
import type { IndexSearchExportPageInput } from './index-search-export-page.input.js';

function setup(result: 'claimed' | 'occupied' | 'expired' | 'stale' = 'claimed') {
  const steps: string[] = [];
  const listOrganizations = vi
    .fn<SearchSystemAuthority['listOrganizations']>()
    .mockImplementation(() => {
      steps.push('roster');
      return Promise.resolve({ items: ['tenant'], nextCursor: null });
    });
  const listTaskProjections = vi
    .fn<SearchSystemAuthority['listTaskProjections']>()
    .mockImplementation(() => {
      steps.push('read');
      return Promise.resolve({
        items: [{ kind: 'space', id: 'space', version: 1, name: 'Space', lifecycle: 'active' }],
        nextCursor: null,
      });
    });
  const authority: SearchSystemAuthority = {
    listOrganizations,
    listTaskProjections,
    resolveTaskProjections: vi.fn(),
    listDocuments: vi.fn(),
    resolveDocuments: vi.fn(),
    listAttachments: vi.fn(),
    resolveAttachments: vi.fn(),
  };
  const write = vi.fn<SearchProjectionIndexerPort['write']>().mockImplementation(() => {
    steps.push('write');
    return Promise.resolve();
  });
  const claimExportPage = vi.fn().mockImplementation(() => {
    steps.push('claim');
    return Promise.resolve(result);
  });
  const recordExportPage = vi.fn().mockImplementation(() => {
    steps.push('record');
    return Promise.resolve('applied');
  });
  const recordRosterPage = vi.fn().mockImplementation(() => {
    steps.push('record-roster');
    return Promise.resolve('applied');
  });
  const unitOfWork: SearchRebuildExportPort = {
    run: (work) => work({ claimExportPage, recordExportPage, recordRosterPage }),
  };
  const command = new IndexSearchExportPage(
    authority,
    { write },
    new ClaimSearchExportPage(unitOfWork),
    new RecordSearchRosterPage(unitOfWork),
    new RecordSearchExportPage(unitOfWork),
  );
  const input: IndexSearchExportPageInput = {
    generation: {
      id: 'g',
      indexUid: 'idx',
      engineCreatedAt: 'time',
      status: 'building',
      brokerAtStart: {
        stream: 'EVENTS',
        createdAt: 'time',
        firstSequence: 1,
        lastSequence: 1,
        retainedGapCount: 0,
        consumers: [],
      },
    },
    checkpoint: { source: 'space', organizationId: 'tenant', cursor: null, inFlightDeadline: null },
    claimToken: '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01',
    claimedAt: new Date('2026-11-20T00:00:00Z'),
    claimDeadline: new Date('2026-11-20T00:01:00Z'),
  };
  return { command, input, steps, write, recordExportPage, recordRosterPage, listOrganizations };
}

describe('IndexSearchExportPage', () => {
  it('reads, claims, confirms its physical write, then advances the checkpoint', async () => {
    const { command, input, steps, recordExportPage } = setup();
    await expect(command.execute(input)).resolves.toBe('progressed');
    expect(steps).toEqual(['read', 'claim', 'write', 'record']);
    expect(recordExportPage).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: input.claimToken, nextCursor: null }),
    );
  });

  it.each(['occupied', 'expired', 'stale'] as const)(
    'does not write when the claim is %s',
    async (result) => {
      const { command, input, write, recordExportPage } = setup(result);
      await expect(command.execute(input)).resolves.toBe(result);
      expect(write).not.toHaveBeenCalled();
      expect(recordExportPage).not.toHaveBeenCalled();
    },
  );

  it('leaves the checkpoint untouched when the physical write has an uncertain outcome', async () => {
    const { command, input, steps, write, recordExportPage } = setup();
    write.mockRejectedValueOnce(new Error('timeout'));
    await expect(command.execute(input)).rejects.toThrow('timeout');
    expect(steps).toEqual(['read', 'claim']);
    expect(recordExportPage).not.toHaveBeenCalled();
  });

  it('records an organization roster without a physical write', async () => {
    const { command, input, steps, write, recordRosterPage } = setup();
    await expect(
      command.execute({
        ...input,
        checkpoint: {
          source: 'organization',
          organizationId: null,
          cursor: null,
          inFlightDeadline: null,
        },
      }),
    ).resolves.toBe('progressed');
    expect(steps).toEqual(['roster', 'record-roster']);
    expect(write).not.toHaveBeenCalled();
    expect(recordRosterPage).toHaveBeenCalledWith(
      expect.objectContaining({ organizationIds: ['tenant'] }),
    );
  });

  it('returns complete only for a missing checkpoint', async () => {
    const { command, input, steps } = setup();
    await expect(command.execute({ ...input, checkpoint: null })).resolves.toBe('complete');
    expect(steps).toEqual([]);
  });
});
