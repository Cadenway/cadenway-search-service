import type { SearchGenerationCheckpoint } from '../../../../models/rebuild/search-generation-checkpoint.model.js';

/** Next checkpoint or null when every known source has completed. */
export type NextSearchGenerationCheckpointOutput = SearchGenerationCheckpoint | null;
