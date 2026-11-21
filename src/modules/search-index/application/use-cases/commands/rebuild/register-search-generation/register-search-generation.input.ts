import type { SearchRebuildBrokerProgress } from '../../../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';

/** Fresh candidate UUID and broker observation collected before opening a transaction. */
export interface RegisterSearchGenerationInput {
  // #region Properties
  /** Newly generated UUID for a candidate. */
  readonly generationId: string;

  /** Stream and consumers before authoritative scans start. */
  readonly brokerAtStart: SearchRebuildBrokerProgress;
  // #endregion
}
