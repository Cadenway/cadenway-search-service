import type {
  DatabaseSchema,
  SystemTransactionRunner,
  TransactionDatabase,
} from '@cadenway/nest-common/database';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { SearchRebuildGeneration } from '../../../../../application/models/rebuild/search-rebuild-generation.model.js';
import type { SearchRebuildRuntime } from '../../../../../application/models/rebuild/search-rebuild-runtime.model.js';
import type { SearchRebuildRuntimePort } from '../../../../../application/ports/outbound/persistence/rebuild/search-rebuild-runtime.port.js';
import {
  searchExportCheckpoints,
  searchIndexGenerations,
  searchPendingRefreshes,
  searchRefreshReceipts,
} from '../../schemas/rebuild/search-rebuild.schema.js';

/** Reads the current candidate or published index pointer without taking the promotion lock. */
export class DrizzleSearchRuntimeStateRepository implements SearchRebuildRuntimePort {
  // #region Constructor
  /** Receives the system runner for the Search-owned index state. */
  public constructor(private readonly system: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Finds the unique current generation in one lifecycle phase. */
  public async findGeneration(
    status: 'building' | 'active',
    signal?: AbortSignal,
  ): Promise<{ readonly generation: SearchRebuildGeneration; readonly updatedAt: Date } | null> {
    signal?.throwIfAborted();
    const rows = await this.system.run(
      ({ db }) =>
        db
          .select({
            id: searchIndexGenerations.id,
            indexUid: searchIndexGenerations.indexUid,
            engineCreatedAt: searchIndexGenerations.engineCreatedAt,
            brokerAtStart: searchIndexGenerations.brokerAtStart,
            updatedAt: searchIndexGenerations.updatedAt,
          })
          .from(searchIndexGenerations)
          .where(eq(searchIndexGenerations.status, status))
          .limit(1),
      { readOnly: true },
    );
    signal?.throwIfAborted();
    const row = rows[0];
    if (!row) return null;
    const { updatedAt, ...generation } = row;
    return { generation: { ...generation, status }, updatedAt };
  }

  /** Loads the current pointers and uncertain writes in one read-only snapshot. */
  public async readState(): Promise<SearchRebuildRuntime> {
    return this.system.run(
      async ({ db }): Promise<SearchRebuildRuntime> => {
        const rows = await db
          .select()
          .from(searchIndexGenerations)
          .where(inArray(searchIndexGenerations.status, ['active', 'building']))
          .limit(2);
        const active = rows.find((row) => row.status === 'active');
        const building = rows.find((row) => row.status === 'building');
        const activeQueueStuck = active !== undefined && (await hasExpiredRefresh(db, active.id));
        if (building === undefined) {
          return {
            active: active === undefined ? null : { ...active, status: 'active' },
            activeQueueStuck,
            building: null,
            buildingHasExpiredIntent: false,
            pendingCascades: false,
          };
        }
        const expiredExports = await db
          .select({ token: searchExportCheckpoints.writeToken })
          .from(searchExportCheckpoints)
          .where(
            and(
              eq(searchExportCheckpoints.generationId, building.id),
              sql`${searchExportCheckpoints.writeDeadline} <= clock_timestamp()`,
            ),
          )
          .limit(1);
        const pendingParents = await db
          .select({ sourceId: searchPendingRefreshes.sourceId })
          .from(searchPendingRefreshes)
          .where(
            and(
              eq(searchPendingRefreshes.generationId, building.id),
              inArray(searchPendingRefreshes.resourceKind, ['list', 'space']),
            ),
          )
          .limit(1);
        return {
          active: active === undefined ? null : { ...active, status: 'active' },
          activeQueueStuck,
          building: {
            generation: { ...building, status: 'building' },
            updatedAt: building.updatedAt,
          },
          buildingHasExpiredIntent:
            expiredExports.length > 0 || (await hasExpiredRefresh(db, building.id)),
          pendingCascades: pendingParents.length > 0,
        };
      },
      { isolationLevel: 'repeatable read', readOnly: true },
    );
  }

  /** Removes one receipt batch older than the source retention and dead-letter replay windows. */
  public pruneReceipts(): Promise<number> {
    return this.system.run(async ({ db }): Promise<number> => {
      const expired = await db
        .select({ eventId: searchRefreshReceipts.eventId })
        .from(searchRefreshReceipts)
        .where(sql`${searchRefreshReceipts.processedAt} < clock_timestamp() - interval '45 days'`)
        .orderBy(asc(searchRefreshReceipts.processedAt), asc(searchRefreshReceipts.eventId))
        .limit(1_000)
        .for('update', { skipLocked: true });
      if (expired.length === 0) return 0;
      const removed = await db
        .delete(searchRefreshReceipts)
        .where(
          inArray(
            searchRefreshReceipts.eventId,
            expired.map((receipt) => receipt.eventId),
          ),
        )
        .returning({ eventId: searchRefreshReceipts.eventId });
      return removed.length;
    });
  }
  // #endregion
}

async function hasExpiredRefresh(
  db: TransactionDatabase<DatabaseSchema>,
  generationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ token: searchPendingRefreshes.claimToken })
    .from(searchPendingRefreshes)
    .where(
      and(
        eq(searchPendingRefreshes.generationId, generationId),
        isNotNull(searchPendingRefreshes.claimToken),
        sql`${searchPendingRefreshes.claimDeadline} <= clock_timestamp()`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
