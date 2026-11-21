import type { SearchRefreshClaim } from '../../../../models/rebuild/search-refresh-claim.model.js';
import type { SearchRefreshTarget } from '../../../../models/rebuild/search-refresh-target.model.js';

/** Database-only refresh mutations under the generation control boundary. */
export interface SearchRefreshTransaction {
  // #region Methods
  /** Records locators in the active and building generations before acknowledging delivery. */
  enqueue(
    eventId: string,
    targets: readonly SearchRefreshTarget[],
    brokerSequence: number,
  ): Promise<void>;

  /** Claims an unclaimed locator from this generation, leaving expired claims for recovery. */
  claimNext(
    generationId: string,
    token: string,
    deadline: Date,
  ): Promise<SearchRefreshClaim | null>;

  /**
   * Settles work for the current token. An applied revision may leave a newer revision pending.
   * Use released only when no physical write was attempted. An uncertain write remains claimed.
   */
  finish(claim: SearchRefreshClaim, result: 'applied' | 'released'): Promise<void>;
  // #endregion
}
