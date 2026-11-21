import type { SearchRebuildExportPosition } from './search-rebuild-export-position.model.js';

/** An organization roster page and the tenants to initialize atomically with its cursor. */
export interface SearchRebuildExportRosterPage extends SearchRebuildExportPosition {
  // #region Properties
  /** Tenant identifiers returned in this roster page. */
  readonly organizationIds: readonly string[];
  // #endregion
}
