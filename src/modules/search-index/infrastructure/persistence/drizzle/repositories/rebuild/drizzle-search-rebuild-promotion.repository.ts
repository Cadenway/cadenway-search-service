import type { DatabaseSchema, TransactionDatabase } from '@cadenway/nest-common/database';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { SearchRebuildCoverage } from '../../../../../application/models/rebuild/search-rebuild-coverage.model.js';
import type { SearchRebuildGeneration } from '../../../../../application/models/rebuild/search-rebuild-generation.model.js';
import type { SearchRebuildPromotionTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-rebuild-promotion-transaction.port.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import {
  searchExportCheckpoints,
  searchIndexGenerations,
  searchPendingRefreshes,
  searchTerminalAdvisories,
} from '../../schemas/rebuild/search-rebuild.schema.js';

const tenantSources = ['task', 'list', 'space', 'document', 'storage'] as const;

/** Database work performed while the caller holds the rebuild control row. */
export class DrizzleSearchRebuildPromotionRepository implements SearchRebuildPromotionTransaction {
  // #region Constructor
  /** Binds every operation to the same system transaction. */
  public constructor(private readonly db: TransactionDatabase<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Reads one generation by its identifier. */
  public async findGeneration(id: string): Promise<SearchRebuildGeneration | null> {
    const rows = await this.db
      .select({
        id: searchIndexGenerations.id,
        indexUid: searchIndexGenerations.indexUid,
        engineCreatedAt: searchIndexGenerations.engineCreatedAt,
        status: searchIndexGenerations.status,
        brokerAtStart: searchIndexGenerations.brokerAtStart,
      })
      .from(searchIndexGenerations)
      .where(eq(searchIndexGenerations.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (!isGenerationStatus(row.status)) {
      throw new SearchRebuildPromotionError('The stored generation status is invalid.');
    }
    return { ...row, status: row.status };
  }

  /** Checks all export scopes, pending refreshes and unresolved advisories. */
  public async readCoverage(candidate: SearchRebuildGeneration): Promise<SearchRebuildCoverage> {
    const roster = await this.db
      .select({ complete: searchExportCheckpoints.complete })
      .from(searchExportCheckpoints)
      .where(
        and(
          eq(searchExportCheckpoints.generationId, candidate.id),
          eq(searchExportCheckpoints.source, 'organization'),
          isNull(searchExportCheckpoints.organizationId),
        ),
      )
      .limit(1);
    const incompleteScopes = await this.db
      .select({ organizationId: searchExportCheckpoints.organizationId })
      .from(searchExportCheckpoints)
      .where(
        and(
          eq(searchExportCheckpoints.generationId, candidate.id),
          isNotNull(searchExportCheckpoints.organizationId),
        ),
      )
      .groupBy(searchExportCheckpoints.organizationId)
      .having(
        sql`count(*) <> ${tenantSources.length} or not bool_and(${searchExportCheckpoints.complete})`,
      )
      .limit(1);
    const organizationComplete = roster[0]?.complete === true;
    const pending = await this.db
      .select({ generationId: searchPendingRefreshes.generationId })
      .from(searchPendingRefreshes)
      .where(eq(searchPendingRefreshes.generationId, candidate.id))
      .limit(1);
    const advisories = await this.db
      .select({ sequence: searchTerminalAdvisories.sequence })
      .from(searchTerminalAdvisories)
      .where(
        and(
          eq(searchTerminalAdvisories.stream, candidate.brokerAtStart.stream),
          eq(searchTerminalAdvisories.streamCreatedAt, candidate.brokerAtStart.createdAt),
          isNull(searchTerminalAdvisories.resolvedAt),
        ),
      )
      .limit(1);
    return {
      sourceCheckpoints: [
        { source: 'organization', complete: organizationComplete },
        ...tenantSources.map((source) => ({
          source,
          complete: organizationComplete && incompleteScopes.length === 0,
        })),
      ],
      hasPendingRefreshes: pending.length !== 0,
      terminalAdvisoriesClear: advisories.length === 0,
    };
  }

  /** Switches generations atomically within the current transaction. */
  public async activate(candidateId: string, brokerFrontier: number): Promise<void> {
    if (!Number.isSafeInteger(brokerFrontier) || brokerFrontier < 0) {
      throw new SearchRebuildPromotionError('The certified broker frontier is invalid.');
    }
    await this.db
      .update(searchIndexGenerations)
      .set({ status: 'retired', updatedAt: new Date() })
      .where(eq(searchIndexGenerations.status, 'active'));
    const activated = await this.db
      .update(searchIndexGenerations)
      .set({ status: 'active', certifiedBrokerFrontier: brokerFrontier, updatedAt: new Date() })
      .where(
        and(
          eq(searchIndexGenerations.id, candidateId),
          eq(searchIndexGenerations.status, 'building'),
        ),
      )
      .returning({ id: searchIndexGenerations.id });
    if (activated.length !== 1) {
      throw new SearchRebuildPromotionError('The search index generation is not a candidate.');
    }
  }
  // #endregion
}

function isGenerationStatus(status: string): status is SearchRebuildGeneration['status'] {
  return (
    status === 'building' || status === 'active' || status === 'abandoned' || status === 'retired'
  );
}
