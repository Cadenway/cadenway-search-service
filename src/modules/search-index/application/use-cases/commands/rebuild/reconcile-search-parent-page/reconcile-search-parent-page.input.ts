import type { SearchParentCheckpoint } from '../../../../models/rebuild/search-parent-checkpoint.model.js';
import type { SearchRefreshClaim } from '../../../../models/rebuild/search-refresh-claim.model.js';

/** One already-claimed parent and its next bounded reconciliation step. */
export interface ReconcileSearchParentPageInput {
  // #region Properties
  /** Bound physical generation of the claimed parent. */
  readonly generation: {
    readonly id: string;
    readonly indexUid: string;
    readonly engineCreatedAt: string;
  };

  /** List or space invalidation held by this worker. */
  readonly claim: SearchRefreshClaim;

  /** Last persisted stage and source cursor. */
  readonly checkpoint: SearchParentCheckpoint;

  /** Cancellation for external reads and writes. */
  readonly signal?: AbortSignal;
  // #endregion
}
