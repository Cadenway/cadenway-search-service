/** An observation of the event stream and the configured rebuild durables. */
export interface SearchRebuildBrokerProgress {
  // #region Properties
  /** Clear advisory latch identity and last assigned sequence; absent on legacy rows. */
  readonly advisoryLatch?: { readonly createdAt: string; readonly lastSequence: number };

  /** Name of the event stream. */
  readonly stream: string;

  /** Stream creation timestamp at broker precision. */
  readonly createdAt: string;

  /** First retained sequence after reading the durables. */
  readonly firstSequence: number;

  /** Highest assigned sequence before reading the durables. */
  readonly lastSequence: number;

  /** Number of deleted positions within the retained sequence range. */
  readonly retainedGapCount: number;

  /** Observed identities, positions and pending work for the exact-filter durables. */
  readonly consumers: readonly {
    readonly handler: string;
    readonly createdAt: string;
    readonly deliveredSequence: number;
    readonly ackFloorSequence: number;
    readonly pending: number;
    readonly ackPending: number;
  }[];
  // #endregion
}
