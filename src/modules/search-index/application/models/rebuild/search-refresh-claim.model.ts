import type { SearchRefreshTarget } from './search-refresh-target.model.js';

/** One revision of one resource claimed for a physical index generation. */
export interface SearchRefreshClaim extends SearchRefreshTarget {
  // #region Properties
  /** Search-owned generation identifier. */
  readonly generationId: string;

  /** Target revision when the resource was claimed. */
  readonly revision: number;

  /** Unique claim identifier for settlement or safe release. */
  readonly token: string;
  // #endregion
}
