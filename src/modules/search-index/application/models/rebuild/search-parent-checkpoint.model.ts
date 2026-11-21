/** The next bounded stage of one parent reconciliation. */
export interface SearchParentCheckpoint {
  // #region Properties
  /** Existing index descendants, current Task descendants, current lists, or the parent itself. */
  readonly phase: 'indexed' | 'tasks' | 'lists' | 'self';

  /** Source-specific continuation, or null on the first page of a phase. */
  readonly cursor: string | null;
  // #endregion
}
