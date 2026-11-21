import type { SearchRebuildExportTransaction } from './search-rebuild-export-transaction.port.js';

/** Opens a system transaction holding the same control lock as promotion. */
export interface SearchRebuildExportPort {
  // #region Methods
  /** Runs database-only work against a single transaction attempt. */
  run<T>(work: (transaction: SearchRebuildExportTransaction) => Promise<T>): Promise<T>;
  // #endregion
}
