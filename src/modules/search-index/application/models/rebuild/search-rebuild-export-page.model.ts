import type { SearchRebuildExportPosition } from './search-rebuild-export-position.model.js';

/** A tenant-scoped authoritative source page. */
export interface SearchRebuildExportPage extends SearchRebuildExportPosition {
  // #region Properties
  /** Owner tenant from the signed system scope. */
  readonly organizationId: string;

  /** The authoritative source. */
  readonly source: 'task' | 'list' | 'space' | 'document' | 'storage';

  /** Unique token of the physical-write intent acquired before indexing this page. */
  readonly claimToken: string;
  // #endregion
}
