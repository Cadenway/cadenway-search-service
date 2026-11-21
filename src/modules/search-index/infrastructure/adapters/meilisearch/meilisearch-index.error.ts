/** Indexing failure safe to log without the request, credentials, or engine response. */
export class MeilisearchIndexError extends Error {
  // #region Properties
  /** Local failure classification for the worker. */
  public readonly code:
    | 'invalid-configuration'
    | 'invalid-request'
    | 'batch-too-large'
    | 'timeout'
    | 'aborted'
    | 'unavailable'
    | 'invalid-response'
    | 'index-not-found'
    | 'index-already-exists'
    | 'index-replaced'
    | 'task-failed'
    | 'task-canceled';
  // #endregion

  // #region Constructor
  /** Uses only the local code in diagnostics. */
  public constructor(code: MeilisearchIndexError['code']) {
    super(`Meilisearch indexing failed (${code}).`);
    this.name = 'MeilisearchIndexError';
    this.code = code;
  }
  // #endregion
}
