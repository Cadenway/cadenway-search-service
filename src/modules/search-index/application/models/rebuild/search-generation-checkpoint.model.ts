/** The next incomplete authoritative export, ordered by the persistence adapter. */
export interface SearchGenerationCheckpoint {
  // #region Properties
  /** Source to page. */
  readonly source: 'organization' | 'task' | 'list' | 'space' | 'document' | 'storage';

  /** Tenant for a source export, or null for the global organization roster. */
  readonly organizationId: string | null;

  /** Last accepted cursor, or null before the first page. */
  readonly cursor: string | null;

  /** Deadline of an in-flight physical write, or null if no intent exists. */
  readonly inFlightDeadline: Date | null;
  // #endregion
}
