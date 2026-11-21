import type { SearchRebuildPromotionEvidence } from '../../../domain/value-objects/rebuild/search-rebuild-promotion-evidence.value-object.js';

/** Source and delivery coverage read while holding the rebuild control row. */
export interface SearchRebuildCoverage {
  // #region Properties
  /** Per-source aggregate of the authoritative export checkpoints. */
  readonly sourceCheckpoints: SearchRebuildPromotionEvidence['sourceCheckpoints'];

  /** The generation has a refresh waiting or a write with unconfirmed settlement. */
  readonly hasPendingRefreshes: boolean;

  /** All relevant delivery advisories have been handled. */
  readonly terminalAdvisoriesClear: boolean;
  // #endregion
}
