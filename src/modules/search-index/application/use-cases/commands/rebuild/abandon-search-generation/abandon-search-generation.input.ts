import type { SearchGenerationCheckpoint } from '../../../../models/rebuild/search-generation-checkpoint.model.js';

/** Candidate generation to abandon after an uncertain physical creation. */
export interface AbandonSearchGenerationInput {
  // #region Properties
  /** Candidate UUID. */
  readonly generationId: string;

  /** Rejected export position that must still be current and have no pending write. */
  readonly rejectedCheckpoint?: SearchGenerationCheckpoint;
  // #endregion
}
