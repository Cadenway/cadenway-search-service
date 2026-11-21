import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';

import type { ClaimSearchExportPageInput } from './claim-search-export-page.input.js';
import type { ClaimSearchExportPageOutput } from './claim-search-export-page.output.js';

/** Serializes a physical export page write across all replicas. */
export class ClaimSearchExportPage {
  // #region Constructor
  /** Receives the shared rebuild transaction boundary. */
  public constructor(private readonly unitOfWork: SearchRebuildExportPort) {}
  // #endregion

  // #region Methods
  /** Records the intent before external writes and never takes over an expired intent. */
  public async execute(input: ClaimSearchExportPageInput): Promise<ClaimSearchExportPageOutput> {
    if (
      input.generationId.length === 0 ||
      input.organizationId.length === 0 ||
      !['task', 'list', 'space', 'document', 'storage'].includes(input.source) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.claimToken) ||
      !Number.isFinite(input.claimedAt.getTime()) ||
      !Number.isFinite(input.claimDeadline.getTime()) ||
      input.claimDeadline.getTime() <= input.claimedAt.getTime() ||
      (input.expectedCursor !== null &&
        (input.expectedCursor.length === 0 || input.expectedCursor.length > 1024))
    ) {
      throw new Error('Invalid search export claim.');
    }
    return this.unitOfWork.run((transaction) => transaction.claimExportPage(input));
  }
  // #endregion
}
