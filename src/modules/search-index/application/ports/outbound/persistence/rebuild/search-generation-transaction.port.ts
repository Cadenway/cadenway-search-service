import type { SearchGenerationCheckpoint } from '../../../../models/rebuild/search-generation-checkpoint.model.js';
import type { SearchGenerationRegistration } from '../../../../models/rebuild/search-generation-registration.model.js';
import type { SearchRebuildGeneration } from '../../../../models/rebuild/search-rebuild-generation.model.js';

/** Generation state operations holding the singleton rebuild control row. */
export interface SearchGenerationTransaction {
  // #region Methods
  /** Returns the unique currently building generation, if present. */
  findBuilding(): Promise<SearchRebuildGeneration | null>;

  /** Inserts a building generation and its initial global roster checkpoint atomically. */
  register(input: SearchGenerationRegistration): Promise<SearchRebuildGeneration>;

  /** Binds an unset identity or confirms the same existing identity on a building generation. */
  bindIdentity(generationId: string, engineCreatedAt: string): Promise<boolean>;

  /** Marks a candidate abandoned, optionally requiring the rejected checkpoint to be current. */
  abandon(generationId: string, rejectedCheckpoint?: SearchGenerationCheckpoint): Promise<boolean>;

  /** Returns one incomplete checkpoint, roster first, then source and organization order. */
  nextCheckpoint(generationId: string): Promise<SearchGenerationCheckpoint | null>;
  // #endregion
}
