import type { SearchAuthorityModel } from '../../../../models/authority/search-authority.model.js';
import type { SearchRefreshClaim } from '../../../../models/rebuild/search-refresh-claim.model.js';
import type { SearchSystemAuthority } from '../../../../ports/outbound/http/authority/search-system-authority.port.js';
import type { SearchRefreshUnitOfWork } from '../../../../ports/outbound/persistence/rebuild/search-refresh-unit-of-work.port.js';
import type { SearchProjectionIndexerPort } from '../../../../ports/outbound/search/rebuild/search-projection-indexer.port.js';
import type { SearchProjectionRemoverPort } from '../../../../ports/outbound/search/rebuild/search-projection-remover.port.js';
import { nextSearchReadAttempt } from '../../../../../domain/policies/rebuild/search-read-retry.policy.js';

import type { RefreshSearchProjectionInput } from './refresh-search-projection.input.js';
import type { RefreshSearchProjectionOutput } from './refresh-search-projection.output.js';

type Projection =
  | SearchAuthorityModel['taskProjection']
  | SearchAuthorityModel['documentProjection']
  | SearchAuthorityModel['attachmentProjection'];

/** Refreshes one locator from its owner before settling the matching queue revision. */
export class RefreshSearchProjection {
  // #region Constructor
  /** Binds the queue, authoritative reads and confirmed physical writes. */
  public constructor(
    private readonly unitOfWork: SearchRefreshUnitOfWork,
    private readonly authority: SearchSystemAuthority,
    private readonly indexer: SearchProjectionIndexerPort,
    private readonly remover: SearchProjectionRemoverPort,
  ) {}
  // #endregion

  // #region Methods
  /** Processes one queued locator, leaving any uncertain physical write claimed for recovery. */
  public async execute(
    input: RefreshSearchProjectionInput,
  ): Promise<RefreshSearchProjectionOutput> {
    if (
      input.generation.id.length === 0 ||
      input.generation.indexUid.length === 0 ||
      input.generation.engineCreatedAt.length === 0 ||
      input.token.length === 0 ||
      !Number.isFinite(input.deadline.getTime()) ||
      input.deadline.getTime() <= Date.now()
    ) {
      throw new RangeError('Invalid Search refresh claim.');
    }
    const claim = await this.unitOfWork.run((transaction) =>
      transaction.claimNext(input.generation.id, input.token, input.deadline),
    );
    if (claim === null) return 'idle';

    // Parent lifecycle changes require reconciling their existing and current descendants first.
    if (claim.kind === 'list' || claim.kind === 'space') {
      await this.release(claim);
      return 'requires-cascade';
    }

    let projection: Projection | null;
    try {
      projection = await this.resolve(claim, input.signal);
      input.signal?.throwIfAborted();
    } catch (error: unknown) {
      await this.unitOfWork.run((transaction) =>
        transaction.finish(claim, 'released', nextSearchReadAttempt()),
      );
      throw error;
    }

    if (projection === null) {
      await this.remover.remove(input.generation, claim, input.signal);
    } else {
      await this.indexer.write(
        input.generation,
        claim.organizationId,
        claim.kind,
        [projection],
        input.signal,
      );
    }
    await this.unitOfWork.run((transaction) => transaction.finish(claim, 'applied'));
    return 'applied';
  }

  private async release(claim: SearchRefreshClaim): Promise<void> {
    await this.unitOfWork.run((transaction) => transaction.finish(claim, 'released'));
  }

  private async resolve(
    claim: SearchRefreshClaim,
    signal?: AbortSignal,
  ): Promise<Projection | null> {
    if (claim.kind === 'task') {
      const response = await this.authority.resolveTaskProjections(
        claim.organizationId,
        { kind: claim.kind, ids: [claim.sourceId] },
        signal,
      );
      const result = response.results[0];
      if (response.results.length !== 1 || result === undefined)
        throw new Error('Invalid Task evidence.');
      if (result.status === 'absent') {
        if (result.id !== claim.sourceId) throw new Error('Invalid Task evidence.');
        return null;
      }
      if (result.projection.kind !== claim.kind || result.projection.id !== claim.sourceId) {
        throw new Error('Invalid Task evidence.');
      }
      return result.projection;
    }
    if (claim.kind === 'document') {
      const response = await this.authority.resolveDocuments(
        claim.organizationId,
        { documentIds: [claim.sourceId] },
        signal,
      );
      const result = response.results[0];
      if (response.results.length !== 1 || result === undefined)
        throw new Error('Invalid Document evidence.');
      const id = result.status === 'present' ? result.projection.documentId : result.documentId;
      if (id !== claim.sourceId) throw new Error('Invalid Document evidence.');
      return result.status === 'present' ? result.projection : null;
    }
    if (claim.kind === 'storage') {
      const response = await this.authority.resolveAttachments(
        claim.organizationId,
        { fileIds: [claim.sourceId] },
        signal,
      );
      const result = response.results[0];
      if (response.results.length !== 1 || result === undefined)
        throw new Error('Invalid Storage evidence.');
      const id = result.status === 'present' ? result.projection.fileId : result.fileId;
      if (id !== claim.sourceId) throw new Error('Invalid Storage evidence.');
      return result.status === 'present' ? result.projection : null;
    }
    throw new Error('Parent Search refresh requires descendant reconciliation.');
  }
  // #endregion
}
