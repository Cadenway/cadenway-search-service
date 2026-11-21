/** Verified caller and validated palette query from the HTTP boundary. */
export interface SearchPaletteInput {
  // #region Properties
  /** Selected organization from the verified internal token. */
  readonly organizationId: string;

  /** User from the verified internal token. */
  readonly userId: string;

  /** Text requested by the caller. */
  readonly query: string;

  /** Maximum disclosed items. */
  readonly limit: number;

  /** Opaque continuation supplied by the caller. */
  readonly cursor?: string;

  /** Cancellation of the HTTP request or its budget. */
  readonly signal?: AbortSignal;
  // #endregion
}
