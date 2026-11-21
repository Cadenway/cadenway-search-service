import { describe, expect, it, vi } from 'vitest';

import type { SearchRefreshClaim } from '../../../../models/rebuild/search-refresh-claim.model.js';
import type { SearchSystemAuthority } from '../../../../ports/outbound/http/authority/search-system-authority.port.js';
import type { SearchRefreshTransaction } from '../../../../ports/outbound/persistence/rebuild/search-refresh-transaction.port.js';
import type { SearchProjectionIndexerPort } from '../../../../ports/outbound/search/rebuild/search-projection-indexer.port.js';
import type { SearchProjectionRemoverPort } from '../../../../ports/outbound/search/rebuild/search-projection-remover.port.js';

import { RefreshSearchProjection } from './refresh-search-projection.use-case.js';

const claim: SearchRefreshClaim = {
  generationId: 'generation',
  organizationId: 'organization',
  kind: 'task',
  sourceId: 'CAD-482',
  revision: 1,
  token: 'token',
};
const generation = { id: 'generation', indexUid: 'index', engineCreatedAt: 'created' };
const input = { generation, token: 'token', deadline: new Date('2100-01-01') };
const projection = {
  kind: 'task' as const,
  id: 'CAD-482',
  version: 2,
  name: 'Example',
  lifecycle: 'active' as const,
  status: 'progress',
  listId: 'list',
  spaceId: 'space',
};

function fixture(current: SearchRefreshClaim | null = claim) {
  const claimNext = vi.fn<SearchRefreshTransaction['claimNext']>().mockResolvedValue(current);
  const finish = vi.fn<SearchRefreshTransaction['finish']>().mockResolvedValue(undefined);
  const resolveTaskProjections = vi
    .fn<SearchSystemAuthority['resolveTaskProjections']>()
    .mockResolvedValue({ results: [{ status: 'present', projection }] });
  const resolveDocuments = vi.fn<SearchSystemAuthority['resolveDocuments']>();
  const resolveAttachments = vi.fn<SearchSystemAuthority['resolveAttachments']>();
  const authority = {
    resolveTaskProjections,
    resolveDocuments,
    resolveAttachments,
  } as unknown as SearchSystemAuthority;
  const write = vi.fn<SearchProjectionIndexerPort['write']>().mockResolvedValue(undefined);
  const remove = vi.fn<SearchProjectionRemoverPort['remove']>().mockResolvedValue(undefined);
  const useCase = new RefreshSearchProjection(
    {
      run: async (work) =>
        work({ claimNext, finish, enqueue: vi.fn<SearchRefreshTransaction['enqueue']>() }),
    },
    authority,
    { write },
    { remove },
  );
  return {
    useCase,
    claimNext,
    finish,
    resolveTaskProjections,
    resolveDocuments,
    resolveAttachments,
    write,
    remove,
  };
}

describe('RefreshSearchProjection', () => {
  it('writes the current Task projection before settling the claimed revision', async () => {
    const { useCase, resolveTaskProjections, write, finish } = fixture();
    await expect(useCase.execute(input)).resolves.toBe('applied');
    expect(resolveTaskProjections).toHaveBeenCalledWith(
      'organization',
      { kind: 'task', ids: ['CAD-482'] },
      undefined,
    );
    expect(write).toHaveBeenCalledWith(generation, 'organization', 'task', [projection], undefined);
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(finish.mock.invocationCallOrder[0] ?? 0);
    expect(finish).toHaveBeenCalledWith(claim, 'applied');
  });

  it('deletes an owner-confirmed missing attachment', async () => {
    const attachmentClaim = { ...claim, kind: 'storage' as const, sourceId: 'file' };
    const { useCase, resolveAttachments, remove, finish } = fixture(attachmentClaim);
    resolveAttachments.mockResolvedValue({
      results: [{ status: 'absent', fileId: 'file', version: 2 }],
    });
    await expect(useCase.execute(input)).resolves.toBe('applied');
    expect(remove).toHaveBeenCalledWith(generation, attachmentClaim, undefined);
    expect(finish).toHaveBeenCalledWith(attachmentClaim, 'applied');
  });

  it('releases the claim when the authority read fails or supplies a different locator', async () => {
    const { useCase, resolveTaskProjections, finish, write } = fixture();
    resolveTaskProjections.mockResolvedValue({
      results: [{ status: 'absent', id: 'CAD-999', version: null }],
    });
    await expect(useCase.execute(input)).rejects.toThrow('Invalid Task evidence');
    expect(finish).toHaveBeenCalledWith(claim, 'released');
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps the claim after an uncertain physical write', async () => {
    const { useCase, write, finish } = fixture();
    write.mockRejectedValue(new Error('timeout'));
    await expect(useCase.execute(input)).rejects.toThrow('timeout');
    expect(finish).not.toHaveBeenCalled();
  });

  it('does not settle a parent until descendant reconciliation is available', async () => {
    const parent = { ...claim, kind: 'list' as const, sourceId: 'list' };
    const { useCase, finish, write, remove } = fixture(parent);
    await expect(useCase.execute(input)).resolves.toBe('requires-cascade');
    expect(finish).toHaveBeenCalledWith(parent, 'released');
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does nothing when the queue has no claimable resource', async () => {
    const { useCase, finish } = fixture(null);
    await expect(useCase.execute(input)).resolves.toBe('idle');
    expect(finish).not.toHaveBeenCalled();
  });
});
