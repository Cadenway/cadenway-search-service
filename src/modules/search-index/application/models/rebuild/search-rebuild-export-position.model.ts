/** A source page whose successful writes can now be checkpointed. */
export interface SearchRebuildExportPosition {
  // #region Properties
  /** Candidate generation. */
  readonly generationId: string;

  /** Cursor observed before reading the page. */
  readonly expectedCursor: string | null;

  /** Cursor returned by the owner or null for the last page. */
  readonly nextCursor: string | null;
  // #endregion
}
