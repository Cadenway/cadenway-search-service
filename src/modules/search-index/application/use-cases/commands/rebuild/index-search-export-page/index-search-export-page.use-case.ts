import type { SearchAuthorityModel } from '../../../../models/authority/search-authority.model.js';
import type { SearchSystemAuthority } from '../../../../ports/outbound/http/authority/search-system-authority.port.js';
import type { SearchProjectionIndexerPort } from '../../../../ports/outbound/search/rebuild/search-projection-indexer.port.js';
import type { ClaimSearchExportPage } from '../claim-search-export-page/claim-search-export-page.use-case.js';
import type { RecordSearchExportPage } from '../record-search-export-page/record-search-export-page.use-case.js';
import type { RecordSearchRosterPage } from '../record-search-roster-page/record-search-roster-page.use-case.js';

import type { IndexSearchExportPageInput } from './index-search-export-page.input.js';
import type { IndexSearchExportPageOutput } from './index-search-export-page.output.js';

/** Reads, indexes and checkpoints one bounded authoritative export page. */
export class IndexSearchExportPage {
  // #region Constructor
  /** Receives authoritative reads, physical indexing and the three database-only commands. */
  public constructor(
    private readonly authority: SearchSystemAuthority,
    private readonly indexer: SearchProjectionIndexerPort,
    private readonly claim: ClaimSearchExportPage,
    private readonly recordRoster: RecordSearchRosterPage,
    private readonly recordPage: RecordSearchExportPage,
  ) {}
  // #endregion

  // #region Methods
  /** Completes at most one source page without holding a database lock across network calls. */
  public async execute(input: IndexSearchExportPageInput): Promise<IndexSearchExportPageOutput> {
    const { generation, checkpoint } = input;
    if (generation.status !== 'building' || generation.engineCreatedAt === null) {
      throw new Error('Search generation has no confirmed physical identity.');
    }
    if (checkpoint === null) return 'complete';
    const query = {
      ...(checkpoint.cursor === null ? {} : { cursor: checkpoint.cursor }),
      limit: 100,
    };
    if (checkpoint.source === 'organization') {
      if (checkpoint.organizationId !== null) throw new Error('Invalid search roster scope.');
      const page = await this.authority.listOrganizations(query, input.signal);
      await this.recordRoster.execute({
        generationId: generation.id,
        expectedCursor: checkpoint.cursor,
        nextCursor: page.nextCursor,
        organizationIds: page.items,
      });
      return 'progressed';
    }
    const organizationId = checkpoint.organizationId;
    if (organizationId === null) throw new Error('Invalid search source scope.');
    const source = checkpoint.source;
    let page: {
      readonly items: readonly (
        | SearchAuthorityModel['taskProjection']
        | SearchAuthorityModel['documentProjection']
        | SearchAuthorityModel['attachmentProjection']
      )[];
      readonly nextCursor: string | null;
    };
    if (source === 'document') {
      page = await this.authority.listDocuments(organizationId, query, input.signal);
    } else if (source === 'storage') {
      page = await this.authority.listAttachments(organizationId, query, input.signal);
    } else {
      page = await this.authority.listTaskProjections(
        organizationId,
        { ...query, kind: source },
        input.signal,
      );
    }
    const intent = {
      generationId: generation.id,
      organizationId,
      source,
      expectedCursor: checkpoint.cursor,
      claimToken: input.claimToken,
      claimedAt: input.claimedAt,
      claimDeadline: input.claimDeadline,
    };
    const result = await this.claim.execute(intent);
    if (result !== 'claimed') return result;
    await this.indexer.write(
      {
        id: generation.id,
        indexUid: generation.indexUid,
        engineCreatedAt: generation.engineCreatedAt,
      },
      organizationId,
      source,
      page.items,
      input.signal,
    );
    await this.recordPage.execute({
      generationId: generation.id,
      organizationId,
      source,
      expectedCursor: checkpoint.cursor,
      nextCursor: page.nextCursor,
      claimToken: input.claimToken,
    });
    return 'progressed';
  }
  // #endregion
}
