/** A single bounded attempt to refresh one queued index resource. */
export interface RefreshSearchProjectionInput {
  // #region Properties
  /** The already-bound physical generation. */
  readonly generation: {
    readonly id: string;
    readonly indexUid: string;
    readonly engineCreatedAt: string;
  };

  /** A unique claim token, generated before opening the database transaction. */
  readonly token: string;

  /** Time after which an unsettled claim requires recovery. */
  readonly deadline: Date;

  /** Cancellation shared by authority and engine operations. */
  readonly signal?: AbortSignal;
  // #endregion
}
