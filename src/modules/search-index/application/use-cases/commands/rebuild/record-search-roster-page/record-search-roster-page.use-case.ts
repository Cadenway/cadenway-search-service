import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';

import type { RecordSearchRosterPageInput } from './record-search-roster-page.input.js';

/** Records roster progress together with each tenant's initial source checkpoints. */
export class RecordSearchRosterPage {
  // #region Constructor
  /** Receives the shared rebuild transaction boundary. */
  public constructor(private readonly unitOfWork: SearchRebuildExportPort) {}
  // #endregion

  // #region Methods
  /** Advances the global roster checkpoint, allowing an exact committed page to be retried. */
  public async execute(input: RecordSearchRosterPageInput): Promise<void> {
    if (
      input.generationId.length === 0 ||
      input.organizationIds.length > 100 ||
      input.organizationIds.some((id) => id.length === 0) ||
      new Set(input.organizationIds).size !== input.organizationIds.length ||
      (input.expectedCursor !== null &&
        (input.expectedCursor.length === 0 || input.expectedCursor.length > 1024)) ||
      (input.nextCursor !== null &&
        (input.nextCursor.length === 0 ||
          input.nextCursor.length > 1024 ||
          input.nextCursor === input.expectedCursor))
    ) {
      throw new Error('Invalid search roster checkpoint.');
    }

    await this.unitOfWork.run(async (transaction): Promise<void> => {
      if ((await transaction.recordRosterPage(input)) === 'stale') {
        throw new Error('Search roster checkpoint changed.');
      }
    });
  }
  // #endregion
}
