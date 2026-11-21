import type { SearchGenerationTransaction } from './search-generation-transaction.port.js';

/** Opens a system transaction holding the shared rebuild control row. */
export interface SearchGenerationPort {
  // #region Methods
  /** Runs only database operations while holding the control lock. */
  run<T>(work: (transaction: SearchGenerationTransaction) => Promise<T>): Promise<T>;
  // #endregion
}
