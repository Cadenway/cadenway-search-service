import type { SearchRefreshTarget } from '../../../../models/rebuild/search-refresh-target.model.js';

/** Reads indexed descendants by parent without returning indexed resource content. */
export interface SearchParentDescendantReader {
  // #region Methods
  /** Returns at most 100 locators from a stable, generation-bound ordered continuation. */
  read(input: {
    readonly generation: {
      readonly id: string;
      readonly indexUid: string;
      readonly engineCreatedAt: string;
    };
    readonly parent: SearchRefreshTarget;
    readonly cursor: string | null;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly items: readonly SearchRefreshTarget[];
    readonly nextCursor: string | null;
  }>;
  // #endregion
}
