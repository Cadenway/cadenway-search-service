import type { SearchRebuildBrokerProgress } from '../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';

/** Values inserted with a new candidate generation and its initial roster checkpoint. */
export interface SearchGenerationRegistration {
  // #region Properties
  /** Candidate UUID. */
  readonly id: string;

  /** Index name uniquely derived from the candidate UUID. */
  readonly indexUid: string;

  /** Broker identity and progress observed before starting the authority scans. */
  readonly brokerAtStart: SearchRebuildBrokerProgress;
  // #endregion
}
