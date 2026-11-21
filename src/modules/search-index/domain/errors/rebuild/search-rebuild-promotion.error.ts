/** The base error for a refused search rebuild domain operation. */
abstract class DomainError extends Error {}

/** The candidate generation cannot be promoted with the supplied evidence. */
export class SearchRebuildPromotionError extends DomainError {
  // #region Properties
  /** Identifies the promotion failure in error reporting. */
  public override readonly name = 'SearchRebuildPromotionError';

  /** Distinguishes a lost generation from evidence that can be checked again. */
  public readonly reason: 'invalidated' | 'not-ready';
  // #endregion

  // #region Constructor
  /** Records the promotion failure and whether this generation can be retried. */
  public constructor(message: string, reason: SearchRebuildPromotionError['reason'] = 'not-ready') {
    super(message);
    this.reason = reason;
  }
  // #endregion
}
