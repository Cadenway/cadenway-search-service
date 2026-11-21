import type { SearchGenerationCheckpoint } from '../../../../models/rebuild/search-generation-checkpoint.model.js';
import type { SearchRebuildGeneration } from '../../../../models/rebuild/search-rebuild-generation.model.js';

/** One authoritative checkpoint and the unique intent for its physical write. */
export interface IndexSearchExportPageInput {
  // #region Properties
  /** Building generation whose engine identity has already been recorded. */
  readonly generation: SearchRebuildGeneration;

  /** Next incomplete checkpoint, or null when all checkpoints are complete. */
  readonly checkpoint: SearchGenerationCheckpoint | null;

  /** Unique claim UUID generated for this page attempt. */
  readonly claimToken: string;

  /** Caller clock observation for the claim. */
  readonly claimedAt: Date;

  /** Deadline after which an uncertain physical write requires abandonment. */
  readonly claimDeadline: Date;

  /** Cancellation of source and engine I/O. */
  readonly signal?: AbortSignal;
  // #endregion
}
