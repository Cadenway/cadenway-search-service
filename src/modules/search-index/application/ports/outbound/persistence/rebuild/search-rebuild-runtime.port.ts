import type { SearchRebuildRuntime } from '../../../../models/rebuild/search-rebuild-runtime.model.js';

/** Reads the current generations and their queue safety observations. */
export interface SearchRebuildRuntimePort {
  // #region Methods
  /** Returns a bounded snapshot of coordinator state. */
  readState(): Promise<SearchRebuildRuntime>;
  // #endregion
}
