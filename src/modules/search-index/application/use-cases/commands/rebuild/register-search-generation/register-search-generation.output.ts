import type { SearchRebuildGeneration } from '../../../../models/rebuild/search-rebuild-generation.model.js';

/** The registered candidate and whether this caller won the creation lock. */
export interface RegisterSearchGenerationOutput {
  // #region Properties
  /** Current building candidate. */
  readonly generation: SearchRebuildGeneration;

  /** Only this caller may submit creation of the new physical index. */
  readonly newlyRegistered: boolean;
  // #endregion
}
