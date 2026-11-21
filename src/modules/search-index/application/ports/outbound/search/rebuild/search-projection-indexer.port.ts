import type { SearchAuthorityModel } from '../../../../models/authority/search-authority.model.js';

/** Writes validated authoritative projections to a specific physical index generation. */
export interface SearchProjectionIndexerPort {
  // #region Methods
  /** Confirms the physical write task before resolving. */
  write(
    generation: {
      readonly id: string;
      readonly indexUid: string;
      readonly engineCreatedAt: string;
    },
    organizationId: string,
    source: 'task' | 'list' | 'space' | 'document' | 'storage',
    projections: readonly (
      | SearchAuthorityModel['taskProjection']
      | SearchAuthorityModel['documentProjection']
      | SearchAuthorityModel['attachmentProjection']
    )[],
    signal?: AbortSignal,
  ): Promise<void>;
  // #endregion
}
