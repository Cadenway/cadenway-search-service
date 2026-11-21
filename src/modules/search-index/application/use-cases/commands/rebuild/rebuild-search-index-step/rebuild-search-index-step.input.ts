/** Values supplied to one bounded coordinator step. */
export interface RebuildSearchIndexStepInput {
  // #region Properties
  /** Fresh candidate UUID, used only if no building generation exists. */
  readonly generationId: string;

  /** Fresh UUID for a single physical write intent. */
  readonly claimToken: string;

  /** Current observed time. */
  readonly now: Date;

  /** Deadline for any physical write claimed by this step. */
  readonly claimDeadline: Date;

  /** Alternating scheduler gives the healthy active generation a refresh turn during rebuild. */
  readonly serveActive: boolean;

  /** Periodically compare the active generation's broker identities with current observations. */
  readonly checkActiveBroker?: boolean;

  /** Cancellation shared by external operations. */
  readonly signal?: AbortSignal;
  // #endregion
}
