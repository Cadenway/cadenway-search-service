/** Physical generation lifecycle operations with confirmed engine results. */
export interface SearchGenerationEnginePort {
  // #region Methods
  /** Creates a fresh physical index, returning its exact creation identity after settings succeed. */
  create(indexUid: string, signal?: AbortSignal): Promise<string>;

  /** Returns null only for a definitely missing index. Other failures reject. */
  readIdentity(indexUid: string, signal?: AbortSignal): Promise<string | null>;
  // #endregion
}
