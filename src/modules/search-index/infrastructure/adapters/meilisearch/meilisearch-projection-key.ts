/** Identifies one source projection within an organization. */
export interface MeilisearchProjectionKey {
  // #region Properties
  /** Source resource type. */
  readonly kind: 'task' | 'list' | 'space' | 'document' | 'attachment';

  /** Stable source ID, or task key for a task. */
  readonly sourceId: string;
  // #endregion
}
