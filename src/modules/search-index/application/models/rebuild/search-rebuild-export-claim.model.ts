/** An exclusive physical-write intent for an incomplete tenant export page. */
export interface SearchRebuildExportClaim {
  // #region Properties
  /** Candidate generation. */
  readonly generationId: string;

  /** The owner tenant. */
  readonly organizationId: string;

  /** The authoritative source. */
  readonly source: 'task' | 'list' | 'space' | 'document' | 'storage';

  /** Cursor observed before reading the page. */
  readonly expectedCursor: string | null;

  /** Unique UUID of this physical-write attempt. */
  readonly claimToken: string;

  /** Time observed by the caller when requesting the intent. */
  readonly claimedAt: Date;

  /** Time by which the caller expects to have committed the page. */
  readonly claimDeadline: Date;
  // #endregion
}
