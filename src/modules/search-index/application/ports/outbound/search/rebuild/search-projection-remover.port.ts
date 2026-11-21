import type { SearchRefreshTarget } from '../../../../models/rebuild/search-refresh-target.model.js';

/** Deletes an authoritative resource locator from one physical index generation. */
export interface SearchProjectionRemoverPort {
  // #region Methods
  /** Confirms the physical deletion before resolving. */
  remove(
    generation: {
      readonly id: string;
      readonly indexUid: string;
      readonly engineCreatedAt: string;
    },
    target: SearchRefreshTarget,
    signal?: AbortSignal,
  ): Promise<void>;
  // #endregion
}
