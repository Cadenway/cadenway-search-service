import type { SearchRefreshTarget } from '../../../../models/rebuild/search-refresh-target.model.js';

/** One delivered event's derived resources and stream position. */
export interface RecordSearchRefreshesInput {
  // #region Properties
  /** Validated immutable ID of the owning service's event. */
  readonly eventId: string;

  /** Confirmed stream sequence attached to an event by JetStream. */
  readonly brokerSequence: number;

  /** Bounded, deduplicated locators derived from the delivered event. */
  readonly targets: readonly SearchRefreshTarget[];
  // #endregion
}
