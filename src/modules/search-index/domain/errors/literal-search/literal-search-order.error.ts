/** Base class for refused literal search domain operations. */
abstract class DomainError extends Error {}

/** The resource identifier cannot be encoded as a stable palette order key. */
export class LiteralSearchOrderError extends DomainError {
  // #region Properties
  /** Identifies an invalid order key without exposing its source identifier. */
  public override readonly name = 'LiteralSearchOrderError';
  // #endregion
}
