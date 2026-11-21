import type { PaletteCandidate } from '../../../../models/palette/palette-candidate.model.js';
import type { PalettePosition } from '../../../../models/palette/palette-position.model.js';

/** Reads one bounded page of ordered candidates from a single physical index generation. */
export interface PaletteCandidateReader {
  // #region Methods
  /** Rejects when the requested generation is unavailable or changed during the read. */
  read(input: {
    readonly organizationId: string;
    readonly normalizedQuery: string;
    readonly after: PalettePosition | null;
    readonly generation: string | null;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly generation: string;
    readonly items: readonly PaletteCandidate[];
    readonly hasMore: boolean;
  }>;
  // #endregion
}
