/** Physical index identity confirmed after creation and settings complete. */
export interface BindSearchGenerationInput {
  // #region Properties
  /** Candidate UUID. */
  readonly generationId: string;

  /** Exact Meilisearch creation timestamp. */
  readonly engineCreatedAt: string;
  // #endregion
}
