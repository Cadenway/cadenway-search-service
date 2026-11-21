/** Tenant-owned locator to resolve from its authoritative service. */
export interface SearchRefreshTarget {
  // #region Properties
  /** Organization of the resource, established by the event envelope. */
  readonly organizationId: string;

  /** Authoritative resource kind. */
  readonly kind: 'task' | 'list' | 'space' | 'document' | 'storage';

  /** Immutable source locator, using the permanent task key for tasks. */
  readonly sourceId: string;
  // #endregion
}
