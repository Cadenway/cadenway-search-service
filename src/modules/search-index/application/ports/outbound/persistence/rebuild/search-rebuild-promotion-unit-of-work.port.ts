import type { SearchRebuildPromotionTransaction } from './search-rebuild-promotion-transaction.port.js';

/** Opens the atomic control boundary shared by promotion and durable invalidation recording. */
export interface SearchRebuildPromotionUnitOfWork {
  // #region Methods
  /** Runs the supplied database-only work once per transaction attempt under the control lock. */
  run<T>(work: (transaction: SearchRebuildPromotionTransaction) => Promise<T>): Promise<T>;
  // #endregion
}
