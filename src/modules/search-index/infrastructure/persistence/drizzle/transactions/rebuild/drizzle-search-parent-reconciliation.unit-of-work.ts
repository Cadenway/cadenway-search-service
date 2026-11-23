import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { eq } from 'drizzle-orm';

import type { SearchParentCheckpoint } from '../../../../../application/models/rebuild/search-parent-checkpoint.model.js';
import type { SearchRefreshClaim } from '../../../../../application/models/rebuild/search-refresh-claim.model.js';
import type { SearchRefreshTarget } from '../../../../../application/models/rebuild/search-refresh-target.model.js';
import type { SearchParentReconciliationPort } from '../../../../../application/ports/outbound/persistence/rebuild/search-parent-reconciliation.port.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import { DrizzleSearchParentRepository } from '../../repositories/rebuild/drizzle-search-parent.repository.js';
import { searchRebuildControl } from '../../schemas/rebuild/search-rebuild.schema.js';

/** Reconciles a parent under the same singleton lock as generation promotion. */
export class DrizzleSearchParentReconciliation implements SearchParentReconciliationPort {
  // #region Constructor
  /** Uses the system transaction runner. */
  public constructor(private readonly system: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Claims a parent and returns its persisted phase. */
  public async claimNextParent(
    generationId: string,
    token: string,
    deadline: Date,
  ): Promise<{ claim: SearchRefreshClaim; checkpoint: SearchParentCheckpoint } | null> {
    return this.run((repository) => repository.claimNextParent(generationId, token, deadline));
  }

  /** Commits child invalidations and the next parent checkpoint. */
  public async advance(input: {
    readonly claim: SearchRefreshClaim;
    readonly expected: SearchParentCheckpoint;
    readonly next: SearchParentCheckpoint;
    readonly children: readonly SearchRefreshTarget[];
  }): Promise<'advanced' | 'stale' | 'restarted'> {
    return this.run((repository) => repository.advance(input));
  }

  /** Releases a parent before a physical write is attempted. */
  public async release(claim: SearchRefreshClaim, retryAt: Date): Promise<void> {
    return this.run((repository) => repository.release(claim, retryAt));
  }

  /** Settles the physically confirmed parent revision. */
  public async finish(
    claim: SearchRefreshClaim,
    expected: SearchParentCheckpoint,
  ): Promise<'applied' | 'stale' | 'restarted'> {
    return this.run((repository) => repository.finish(claim, expected));
  }

  private async run<T>(
    work: (repository: DrizzleSearchParentRepository) => Promise<T>,
  ): Promise<T> {
    return this.system.run(async (scope): Promise<T> => {
      const control = await scope.db
        .select({ id: searchRebuildControl.id })
        .from(searchRebuildControl)
        .where(eq(searchRebuildControl.id, 1))
        .for('update');
      if (control.length !== 1)
        throw new SearchRebuildPromotionError('The rebuild control row is missing.');
      return work(new DrizzleSearchParentRepository(scope.db));
    });
  }
  // #endregion
}
