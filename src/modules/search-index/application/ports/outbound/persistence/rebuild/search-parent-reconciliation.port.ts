import type { SearchParentCheckpoint } from '../../../../models/rebuild/search-parent-checkpoint.model.js';
import type { SearchRefreshClaim } from '../../../../models/rebuild/search-refresh-claim.model.js';
import type { SearchRefreshTarget } from '../../../../models/rebuild/search-refresh-target.model.js';

/** Atomically records bounded descendants and progress for a claimed parent. */
export interface SearchParentReconciliationPort {
  // #region Methods
  /**
   * Checks the claim token, revision and expected checkpoint under the generation lock, enqueues
   * children and advances the checkpoint in one commit. A newer revision restarts the parent scan.
   */
  advance(input: {
    readonly claim: SearchRefreshClaim;
    readonly expected: SearchParentCheckpoint;
    readonly next: SearchParentCheckpoint;
    readonly children: readonly SearchRefreshTarget[];
  }): Promise<'advanced' | 'stale' | 'restarted'>;

  /** Releases this token after failure before any parent physical write. */
  release(claim: SearchRefreshClaim, retryAt: Date): Promise<void>;

  /** Settles only the claim and revision confirmed by the physical parent write. */
  finish(
    claim: SearchRefreshClaim,
    expected: SearchParentCheckpoint,
  ): Promise<'applied' | 'stale' | 'restarted'>;
  // #endregion
}
