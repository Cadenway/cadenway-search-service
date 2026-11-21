import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';

import type { RecordSearchExportPageInput } from './record-search-export-page.input.js';

/** Records one tenant source page after all its physical index writes succeed. */
export class RecordSearchExportPage {
  // #region Constructor
  /** Receives the shared rebuild transaction boundary. */
  public constructor(private readonly unitOfWork: SearchRebuildExportPort) {}
  // #endregion

  // #region Methods
  /** Advances the source checkpoint, allowing an exact committed page to be retried. */
  public async execute(input: RecordSearchExportPageInput): Promise<void> {
    if (
      input.generationId.length === 0 ||
      input.organizationId.length === 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.claimToken) ||
      !['task', 'list', 'space', 'document', 'storage'].includes(input.source) ||
      (input.expectedCursor !== null &&
        (input.expectedCursor.length === 0 || input.expectedCursor.length > 1024)) ||
      (input.nextCursor !== null &&
        (input.nextCursor.length === 0 ||
          input.nextCursor.length > 1024 ||
          input.nextCursor === input.expectedCursor))
    ) {
      throw new Error('Invalid search source checkpoint.');
    }

    await this.unitOfWork.run(async (transaction): Promise<void> => {
      if ((await transaction.recordExportPage(input)) === 'stale') {
        throw new Error('Search source checkpoint changed.');
      }
    });
  }
  // #endregion
}
