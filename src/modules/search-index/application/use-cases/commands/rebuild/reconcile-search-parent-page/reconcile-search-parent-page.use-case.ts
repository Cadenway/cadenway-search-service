import type { SearchParentCheckpoint } from '../../../../models/rebuild/search-parent-checkpoint.model.js';
import type { SearchRefreshTarget } from '../../../../models/rebuild/search-refresh-target.model.js';
import type { SearchSystemAuthority } from '../../../../ports/outbound/http/authority/search-system-authority.port.js';
import type { SearchParentReconciliationPort } from '../../../../ports/outbound/persistence/rebuild/search-parent-reconciliation.port.js';
import type { SearchParentDescendantReader } from '../../../../ports/outbound/search/rebuild/search-parent-descendant-reader.port.js';
import type { SearchProjectionIndexerPort } from '../../../../ports/outbound/search/rebuild/search-projection-indexer.port.js';
import type { SearchProjectionRemoverPort } from '../../../../ports/outbound/search/rebuild/search-projection-remover.port.js';
import { SearchAuthorityReadError } from '../../../../../domain/errors/authority/search-authority-read.error.js';

import type { ReconcileSearchParentPageInput } from './reconcile-search-parent-page.input.js';
import type { ReconcileSearchParentPageOutput } from './reconcile-search-parent-page.output.js';

/** Reconciles indexed and current descendants before settling a parent invalidation. */
export class ReconcileSearchParentPage {
  // #region Constructor
  /** Receives source readers, durable checkpoint operations and confirmed index writes. */
  public constructor(
    private readonly authority: SearchSystemAuthority,
    private readonly descendants: SearchParentDescendantReader,
    private readonly checkpointStore: SearchParentReconciliationPort,
    private readonly indexer: SearchProjectionIndexerPort,
    private readonly remover: SearchProjectionRemoverPort,
  ) {}
  // #endregion

  // #region Methods
  /** Reads and records at most one page, or resolves and updates the parent at the final stage. */
  public async execute(
    input: ReconcileSearchParentPageInput,
  ): Promise<ReconcileSearchParentPageOutput> {
    const { claim, checkpoint, generation } = input;
    if (
      (claim.kind !== 'list' && claim.kind !== 'space') ||
      claim.generationId !== generation.id ||
      !generation.id ||
      !generation.indexUid ||
      !generation.engineCreatedAt ||
      !claim.token ||
      !Number.isSafeInteger(claim.revision) ||
      claim.revision < 1 ||
      (checkpoint.phase === 'lists' && claim.kind !== 'space') ||
      (checkpoint.phase === 'self' && checkpoint.cursor !== null)
    )
      throw new RangeError('Invalid Search parent reconciliation.');

    if (checkpoint.phase === 'self') return this.reconcileParent(input);

    try {
      input.signal?.throwIfAborted();
      let page;
      try {
        page =
          checkpoint.phase === 'indexed'
            ? await this.descendants.read({
                generation,
                parent: claim,
                cursor: checkpoint.cursor,
                limit: 100,
                signal: input.signal,
              })
            : await this.readAuthorityPage(input);
      } catch (error: unknown) {
        if (
          (checkpoint.phase === 'tasks' || checkpoint.phase === 'lists') &&
          checkpoint.cursor !== null &&
          error instanceof SearchAuthorityReadError &&
          error.reason === 'invalid-request'
        ) {
          input.signal?.throwIfAborted();
          return await this.checkpointStore.advance({
            claim,
            expected: checkpoint,
            next: { phase: checkpoint.phase, cursor: null },
            children: [],
          });
        }
        throw error;
      }
      if (
        page.items.length > 100 ||
        (page.nextCursor !== null && (!page.nextCursor || page.nextCursor === checkpoint.cursor))
      ) {
        throw new Error('Invalid Search parent descendant page.');
      }
      for (const child of page.items) {
        if (
          child.organizationId !== claim.organizationId ||
          !child.sourceId ||
          (child.kind !== 'task' && (claim.kind !== 'space' || child.kind !== 'list'))
        ) {
          throw new Error('Invalid Search parent descendant locator.');
        }
      }
      input.signal?.throwIfAborted();
      return await this.checkpointStore.advance({
        claim,
        expected: checkpoint,
        next: this.nextCheckpoint(claim.kind, checkpoint, page.nextCursor),
        children: page.items,
      });
    } catch (error: unknown) {
      await this.checkpointStore.release(claim);
      throw error;
    }
  }

  private async readAuthorityPage(input: ReconcileSearchParentPageInput): Promise<{
    readonly items: readonly SearchRefreshTarget[];
    readonly nextCursor: string | null;
  }> {
    const { claim, checkpoint } = input;
    const kind = checkpoint.phase === 'tasks' ? 'task' : 'list';
    const response = await this.authority.listTaskProjections(
      claim.organizationId,
      {
        kind,
        limit: 100,
        ...(checkpoint.cursor === null ? {} : { cursor: checkpoint.cursor }),
        ...(claim.kind === 'space' ? { spaceId: claim.sourceId } : { listId: claim.sourceId }),
      },
      input.signal,
    );
    const items: SearchRefreshTarget[] = response.items.map((item) => {
      if (
        item.kind !== kind ||
        (claim.kind === 'space' && item.spaceId !== claim.sourceId) ||
        (claim.kind === 'list' && (item.kind !== 'task' || item.listId !== claim.sourceId))
      ) {
        throw new Error('Invalid Search authority descendant.');
      }
      return { organizationId: claim.organizationId, kind, sourceId: item.id };
    });
    return { items, nextCursor: response.nextCursor };
  }

  private nextCheckpoint(
    kind: 'list' | 'space',
    checkpoint: SearchParentCheckpoint,
    cursor: string | null,
  ): SearchParentCheckpoint {
    if (cursor !== null) return { phase: checkpoint.phase, cursor };
    if (checkpoint.phase === 'indexed') return { phase: 'tasks', cursor: null };
    if (checkpoint.phase === 'tasks' && kind === 'space') return { phase: 'lists', cursor: null };
    return { phase: 'self', cursor: null };
  }

  private async reconcileParent(
    input: ReconcileSearchParentPageInput,
  ): Promise<ReconcileSearchParentPageOutput> {
    const { claim, checkpoint, generation } = input;
    if (claim.kind !== 'list' && claim.kind !== 'space')
      throw new RangeError('Invalid Search parent.');
    let projection;
    try {
      const result = await this.authority.resolveTaskProjections(
        claim.organizationId,
        { kind: claim.kind, ids: [claim.sourceId] },
        input.signal,
      );
      const decision = result.results[0];
      if (
        result.results.length !== 1 ||
        decision === undefined ||
        (decision.status === 'absent' && decision.id !== claim.sourceId) ||
        (decision.status === 'present' &&
          (decision.projection.id !== claim.sourceId || decision.projection.kind !== claim.kind))
      ) {
        throw new Error('Invalid Search parent evidence.');
      }
      projection = decision.status === 'present' ? decision.projection : null;
      input.signal?.throwIfAborted();
    } catch (error: unknown) {
      await this.checkpointStore.release(claim);
      throw error;
    }
    if (projection === null) await this.remover.remove(generation, claim, input.signal);
    else
      await this.indexer.write(
        generation,
        claim.organizationId,
        claim.kind,
        [projection],
        input.signal,
      );
    return this.checkpointStore.finish(claim, checkpoint);
  }
  // #endregion
}
