import type { SearchRebuildExportPage } from '../../../../models/rebuild/search-rebuild-export-page.model.js';
import type { SearchRebuildExportRosterPage } from '../../../../models/rebuild/search-rebuild-export-roster-page.model.js';
import type { SearchRebuildExportClaim } from '../../../../models/rebuild/search-rebuild-export-claim.model.js';

/** Atomic checkpoint changes inside the locked rebuild control transaction. */
export interface SearchRebuildExportTransaction {
  // #region Methods
  /**
   * Acquires the unclaimed matching checkpoint. An expired intent is never replaced and its
   * candidate must be abandoned. The database clock decides whether an intent is expired.
   */
  claimExportPage(
    input: SearchRebuildExportClaim,
  ): Promise<'claimed' | 'occupied' | 'expired' | 'stale'>;

  /**
   * Compares an incomplete tenant checkpoint and its claim, then advances it or completes it
   * and clears the claim in the same transaction.
   * Returns already-applied only when the stored position equals this page's target.
   */
  recordExportPage(
    input: SearchRebuildExportPage,
  ): Promise<'applied' | 'already-applied' | 'stale'>;

  /**
   * Initializes all five tenant checkpoints and advances the roster in one transaction.
   * Returns already-applied only when the stored position equals this page's target.
   */
  recordRosterPage(
    input: SearchRebuildExportRosterPage,
  ): Promise<'applied' | 'already-applied' | 'stale'>;
  // #endregion
}
