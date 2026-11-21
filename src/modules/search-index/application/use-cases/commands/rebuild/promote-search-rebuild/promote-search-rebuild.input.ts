import type { SearchRebuildBrokerProgress } from '../../../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';

/** Observations collected outside PostgreSQL before entering the promotion transaction. */
export interface PromoteSearchRebuildInput {
  // #region Properties
  /** Candidate generation whose index and consumers were inspected. */
  readonly generationId: string;

  /** Verified creation timestamp of the candidate's current physical index. */
  readonly engineCreatedAt: string;

  /** Completed stream and durable sample collected after the export and refresh work. */
  readonly broker: SearchRebuildBrokerProgress;
  // #endregion
}
