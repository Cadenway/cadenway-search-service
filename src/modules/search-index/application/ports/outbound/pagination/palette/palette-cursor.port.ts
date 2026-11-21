import type { PalettePosition } from '../../../../models/palette/palette-position.model.js';

/** Authenticates palette continuation positions against user, organization, query and ordering. */
export interface PaletteCursor {
  // #region Methods
  /** Returns null for an invalid, tampered or mismatched cursor. */
  decode(
    cursor: string,
    binding: {
      readonly userId: string;
      readonly organizationId: string;
      readonly normalizedQuery: string;
    },
  ): Promise<PalettePosition | null>;

  /** Seals a continuation using the same binding checked by decode. */
  encode(binding: {
    readonly userId: string;
    readonly organizationId: string;
    readonly normalizedQuery: string;
    readonly after: PalettePosition;
  }): Promise<string>;
  // #endregion
}
