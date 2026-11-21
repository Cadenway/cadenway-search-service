import { describe, expect, it, vi } from 'vitest';

import type { SearchRefreshClaim } from '../../../../models/rebuild/search-refresh-claim.model.js';
import type { SearchSystemAuthority } from '../../../../ports/outbound/http/authority/search-system-authority.port.js';
import type { SearchParentReconciliationPort } from '../../../../ports/outbound/persistence/rebuild/search-parent-reconciliation.port.js';
import type { SearchParentDescendantReader } from '../../../../ports/outbound/search/rebuild/search-parent-descendant-reader.port.js';
import type { SearchProjectionIndexerPort } from '../../../../ports/outbound/search/rebuild/search-projection-indexer.port.js';
import type { SearchProjectionRemoverPort } from '../../../../ports/outbound/search/rebuild/search-projection-remover.port.js';
import { SearchAuthorityReadError } from '../../../../../domain/errors/authority/search-authority-read.error.js';

import type { ReconcileSearchParentPageInput } from './reconcile-search-parent-page.input.js';
import { ReconcileSearchParentPage } from './reconcile-search-parent-page.use-case.js';

const claim: SearchRefreshClaim = {
  generationId: 'generation',
  organizationId: 'organization',
  kind: 'space',
  sourceId: 'space',
  revision: 3,
  token: 'token',
};
const input: ReconcileSearchParentPageInput = {
  generation: { id: 'generation', indexUid: 'index', engineCreatedAt: 'created' },
  claim,
  checkpoint: { phase: 'indexed', cursor: null },
};

function fixture() {
  const listTaskProjections = vi
    .fn<SearchSystemAuthority['listTaskProjections']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const resolveTaskProjections = vi
    .fn<SearchSystemAuthority['resolveTaskProjections']>()
    .mockResolvedValue({ results: [{ status: 'absent', id: 'space', version: 3 }] });
  const read = vi
    .fn<SearchParentDescendantReader['read']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const advance = vi.fn<SearchParentReconciliationPort['advance']>().mockResolvedValue('advanced');
  const release = vi.fn<SearchParentReconciliationPort['release']>().mockResolvedValue(undefined);
  const finish = vi.fn<SearchParentReconciliationPort['finish']>().mockResolvedValue('applied');
  const write = vi.fn<SearchProjectionIndexerPort['write']>().mockResolvedValue(undefined);
  const remove = vi.fn<SearchProjectionRemoverPort['remove']>().mockResolvedValue(undefined);
  const useCase = new ReconcileSearchParentPage(
    { listTaskProjections, resolveTaskProjections } as unknown as SearchSystemAuthority,
    { read },
    { advance, release, finish },
    { write },
    { remove },
  );
  return {
    useCase,
    read,
    listTaskProjections,
    resolveTaskProjections,
    advance,
    release,
    finish,
    remove,
  };
}

describe('ReconcileSearchParentPage', () => {
  it.each(['tasks', 'lists'] as const)(
    'restarts a rejected %s authority continuation without queuing children',
    async (phase) => {
      const { useCase, listTaskProjections, advance, release } = fixture();
      const checkpoint = { phase, cursor: 'obsolete' };
      listTaskProjections.mockRejectedValue(new SearchAuthorityReadError('invalid-request'));
      await expect(useCase.execute({ ...input, checkpoint })).resolves.toBe('advanced');
      expect(advance).toHaveBeenCalledWith({
        claim,
        expected: checkpoint,
        next: { phase, cursor: null },
        children: [],
      });
      expect(release).not.toHaveBeenCalled();
    },
  );

  it('does not reset an invalid first page or an indexed continuation', async () => {
    const firstPage = fixture();
    firstPage.listTaskProjections.mockRejectedValue(
      new SearchAuthorityReadError('invalid-request'),
    );
    await expect(
      firstPage.useCase.execute({ ...input, checkpoint: { phase: 'tasks', cursor: null } }),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
    expect(firstPage.advance).not.toHaveBeenCalled();
    expect(firstPage.release).toHaveBeenCalledWith(claim);

    const indexed = fixture();
    indexed.read.mockRejectedValue(new SearchAuthorityReadError('invalid-request'));
    await expect(
      indexed.useCase.execute({
        ...input,
        checkpoint: { phase: 'indexed', cursor: 'index-cursor' },
      }),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
    expect(indexed.advance).not.toHaveBeenCalled();
    expect(indexed.release).toHaveBeenCalledWith(claim);
  });

  it('atomically queues old index descendants before advancing to the authority scan', async () => {
    const { useCase, read, advance } = fixture();
    const child = { organizationId: 'organization', kind: 'task' as const, sourceId: 'CAD-1' };
    read.mockResolvedValue({ items: [child], nextCursor: null });
    await expect(useCase.execute(input)).resolves.toBe('advanced');
    expect(advance).toHaveBeenCalledWith({
      claim,
      expected: input.checkpoint,
      next: { phase: 'tasks', cursor: null },
      children: [child],
    });
  });

  it('continues the same bounded page and propagates a concurrent revision restart', async () => {
    const { useCase, read, advance } = fixture();
    read.mockResolvedValue({ items: [], nextCursor: 'next' });
    advance.mockResolvedValue('restarted');
    await expect(useCase.execute(input)).resolves.toBe('restarted');
    expect(advance).toHaveBeenCalledWith(
      expect.objectContaining({ next: { phase: 'indexed', cursor: 'next' } }),
    );
  });

  it('filters current tasks by their authoritative space', async () => {
    const { useCase, listTaskProjections, advance } = fixture();
    const task = {
      kind: 'task' as const,
      id: 'CAD-1',
      version: 1,
      name: 'Task',
      lifecycle: 'active' as const,
      status: 'progress',
      listId: 'list',
      spaceId: 'space',
    };
    listTaskProjections.mockResolvedValue({ items: [task], nextCursor: null });
    await expect(
      useCase.execute({ ...input, checkpoint: { phase: 'tasks', cursor: null } }),
    ).resolves.toBe('advanced');
    expect(listTaskProjections).toHaveBeenCalledWith(
      'organization',
      { kind: 'task', limit: 100, spaceId: 'space' },
      undefined,
    );
    expect(advance).toHaveBeenCalledWith(
      expect.objectContaining({
        next: { phase: 'lists', cursor: null },
        children: [{ organizationId: 'organization', kind: 'task', sourceId: 'CAD-1' }],
      }),
    );
  });

  it('releases a claim when the source returns a locator from another organization', async () => {
    const { useCase, read, release, advance } = fixture();
    read.mockResolvedValue({
      items: [{ organizationId: 'other', kind: 'task', sourceId: 'CAD-1' }],
      nextCursor: null,
    });
    await expect(useCase.execute(input)).rejects.toThrow(
      'Invalid Search parent descendant locator',
    );
    expect(release).toHaveBeenCalledWith(claim);
    expect(advance).not.toHaveBeenCalled();
  });

  it('settles an absent parent only after the physical deletion confirms', async () => {
    const { useCase, remove, finish } = fixture();
    const checkpoint = { phase: 'self' as const, cursor: null };
    await expect(useCase.execute({ ...input, checkpoint })).resolves.toBe('applied');
    expect(remove).toHaveBeenCalledWith(input.generation, claim, undefined);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      finish.mock.invocationCallOrder[0] ?? 0,
    );
    expect(finish).toHaveBeenCalledWith(claim, checkpoint);
  });

  it('keeps the claim on an uncertain physical write', async () => {
    const { useCase, remove, release, finish } = fixture();
    remove.mockRejectedValue(new Error('timeout'));
    await expect(
      useCase.execute({ ...input, checkpoint: { phase: 'self', cursor: null } }),
    ).rejects.toThrow('timeout');
    expect(release).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
});
