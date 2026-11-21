import type { SearchRebuildBrokerProgress } from './search-rebuild-broker-progress.value-object.js';

/** Authority, indexing and catch-up evidence for a single candidate generation. */
export interface SearchRebuildPromotionEvidence {
  // #region Properties
  /** Creation timestamp of the physical index at the start of the rebuild. */
  readonly engineCreatedAtAtStart: string | undefined;

  /** Creation timestamp of the same physical index after checking its writes. */
  readonly engineCreatedAtBeforePromotion: string | undefined;

  /** Completion of each authoritative projection scan. */
  readonly sourceCheckpoints: readonly {
    readonly source: 'organization' | 'task' | 'list' | 'space' | 'document' | 'storage';
    readonly complete: boolean;
  }[];

  /** Every physical index task required by the rebuild has confirmed success. */
  readonly meilisearchTasksSucceeded: boolean;

  /**
   * Certified stream sequence through which all applicable durable invalidations are applied.
   * Exact-filter durables may have no matching delivery at the certified frontier.
   */
  readonly invalidationsAppliedThroughSequence: number;

  /** No unresolved terminal advisory affects the generation. */
  readonly terminalAdvisoriesClear: boolean;

  /** Event stream and durables observed before opening the authority scans. */
  readonly brokerAtStart: SearchRebuildBrokerProgress | undefined;

  /** Event stream and the same durables observed after the scans and before promotion. */
  readonly brokerBeforePromotion: SearchRebuildBrokerProgress | undefined;
  // #endregion
}
