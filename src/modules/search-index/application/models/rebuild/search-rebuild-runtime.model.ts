import type { SearchRebuildGeneration } from './search-rebuild-generation.model.js';

/** Generation state and queue safety observations for one coordinator step. */
export interface SearchRebuildRuntime {
  // #region Properties
  /** Current active generation, if one is selected. */
  readonly active: SearchRebuildGeneration | null;

  /** Current building generation and its last durable state change. */
  readonly building: {
    readonly generation: SearchRebuildGeneration;
    readonly updatedAt: Date;
  } | null;

  /** An uncertain active write prevents safe reuse of its index. */
  readonly activeQueueStuck: boolean;

  /** An expired building-generation write intent prevents reuse of its index. */
  readonly buildingHasExpiredIntent: boolean;

  /** The building generation has parent invalidations needing descendant reconciliation. */
  readonly pendingCascades: boolean;
  // #endregion
}
