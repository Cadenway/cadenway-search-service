import type { SearchRebuildBrokerProgress } from '../../../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';

/** Supplies a broker observation only when terminal deliveries can be ruled out. */
export interface SearchBrokerProgressReader {
  // #region Methods
  /** Samples the Search durables with the terminal advisory guard checked on both sides. */
  read(signal?: AbortSignal): Promise<SearchRebuildBrokerProgress | null>;
  // #endregion
}
