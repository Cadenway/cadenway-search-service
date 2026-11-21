import type { SearchRefreshTransaction } from './search-refresh-transaction.port.js';

/** Runs refresh operations while generation registration and promotion are serialized. */
export interface SearchRefreshUnitOfWork {
  // #region Methods
  /** Executes database-only refresh work. Resolves after commit. */
  run<T>(work: (transaction: SearchRefreshTransaction) => Promise<T>): Promise<T>;
  // #endregion
}
