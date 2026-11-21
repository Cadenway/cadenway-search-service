/** Safe failure of an authoritative Search read. */
export class SearchAuthorityReadError extends Error {
  // #region Properties
  /** Reason that the caller can use to retry, split a batch or stop. */
  public readonly reason: 'invalid-request' | 'batch-too-large' | 'unavailable' | 'cancelled';
  // #endregion

  // #region Constructor
  /** Creates an error without retaining remote details or credentials. */
  public constructor(reason: 'invalid-request' | 'batch-too-large' | 'unavailable' | 'cancelled') {
    super(`Search authority call failed: ${reason}`);
    this.name = 'SearchAuthorityReadError';
    this.reason = reason;
  }
  // #endregion
}
