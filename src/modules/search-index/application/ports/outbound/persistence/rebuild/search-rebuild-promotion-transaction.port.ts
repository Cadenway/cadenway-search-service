import type { SearchRebuildCoverage } from '../../../../models/rebuild/search-rebuild-coverage.model.js';
import type { SearchRebuildGeneration } from '../../../../models/rebuild/search-rebuild-generation.model.js';

/** Rebuild operations bound to one system transaction holding the control row. */
export interface SearchRebuildPromotionTransaction {
  // #region Methods
  /** Loads candidate identity and lifecycle for promotion. */
  findGeneration(id: string): Promise<SearchRebuildGeneration | null>;

  /** Reads source completion, refresh settlement and delivery advisories together. */
  readCoverage(candidate: SearchRebuildGeneration): Promise<SearchRebuildCoverage>;

  /** Retires the prior active generation and activates the candidate with its certified sequence. */
  activate(candidateId: string, brokerFrontier: number): Promise<void>;
  // #endregion
}
