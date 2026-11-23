import type { DatabaseSchema, TransactionDatabase } from '@cadenway/nest-common/database';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { SearchRefreshClaim } from '../../../../../application/models/rebuild/search-refresh-claim.model.js';
import type { SearchRefreshTarget } from '../../../../../application/models/rebuild/search-refresh-target.model.js';
import type { SearchRefreshTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-refresh-transaction.port.js';
import {
  searchIndexGenerations,
  searchPendingRefreshes,
  searchRefreshReceipts,
} from '../../schemas/rebuild/search-rebuild.schema.js';

/** Mutates the durable refresh queue while the rebuild control row is locked. */
export class DrizzleSearchRefreshRepository implements SearchRefreshTransaction {
  // #region Constructor
  /** Binds queue operations to the caller's system transaction. */
  public constructor(private readonly db: TransactionDatabase<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Coalesces event locators in every generation that must receive new updates. */
  public async enqueue(
    eventId: string,
    targets: readonly SearchRefreshTarget[],
    brokerSequence: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(brokerSequence) || brokerSequence < 1 || targets.length > 100) {
      throw new RangeError('Invalid Search refresh batch.');
    }
    const receipt = await this.db
      .insert(searchRefreshReceipts)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ eventId: searchRefreshReceipts.eventId });
    if (receipt.length === 0) return;
    const uniqueTargets = [
      ...new Map(
        targets.map((target) => [
          JSON.stringify([target.organizationId, target.kind, target.sourceId]),
          target,
        ]),
      ).values(),
    ];
    if (uniqueTargets.length === 0) return;
    const generations = await this.db
      .select({ id: searchIndexGenerations.id })
      .from(searchIndexGenerations)
      .where(inArray(searchIndexGenerations.status, ['active', 'building']));
    const rows = generations.flatMap((generation) =>
      uniqueTargets.map((target) => ({
        generationId: generation.id,
        organizationId: target.organizationId,
        resourceKind: target.kind,
        sourceId: target.sourceId,
        maxBrokerSequence: brokerSequence,
      })),
    );
    if (rows.length === 0) return;
    await this.db
      .insert(searchPendingRefreshes)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          searchPendingRefreshes.generationId,
          searchPendingRefreshes.organizationId,
          searchPendingRefreshes.resourceKind,
          searchPendingRefreshes.sourceId,
        ],
        set: {
          maxBrokerSequence: sql`greatest(${searchPendingRefreshes.maxBrokerSequence}, excluded.max_broker_sequence)`,
          revision: sql`${searchPendingRefreshes.revision} + 1`,
          cascadePhase: sql`case when excluded.resource_kind in ('list', 'space') then 'indexed' else null end`,
          cascadeCursor: null,
          updatedAt: new Date(),
        },
      });
  }

  /** Claims a due locator only when its index identity is recorded. */
  public async claimNext(
    generationId: string,
    token: string,
    deadline: Date,
  ): Promise<SearchRefreshClaim | null> {
    const rows = await this.db
      .select({
        organizationId: searchPendingRefreshes.organizationId,
        kind: searchPendingRefreshes.resourceKind,
        sourceId: searchPendingRefreshes.sourceId,
        revision: searchPendingRefreshes.revision,
      })
      .from(searchPendingRefreshes)
      .innerJoin(
        searchIndexGenerations,
        eq(searchIndexGenerations.id, searchPendingRefreshes.generationId),
      )
      .where(
        and(
          eq(searchPendingRefreshes.generationId, generationId),
          isNull(searchPendingRefreshes.claimToken),
          sql`(${searchPendingRefreshes.nextAttemptAt} is null or ${searchPendingRefreshes.nextAttemptAt} <= statement_timestamp())`,
          inArray(searchIndexGenerations.status, ['active', 'building']),
          isNotNull(searchIndexGenerations.engineCreatedAt),
        ),
      )
      .orderBy(
        asc(
          sql`coalesce(${searchPendingRefreshes.nextAttemptAt}, ${searchPendingRefreshes.createdAt})`,
        ),
        asc(searchPendingRefreshes.maxBrokerSequence),
        asc(searchPendingRefreshes.organizationId),
        asc(searchPendingRefreshes.resourceKind),
        asc(searchPendingRefreshes.sourceId),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (!isRefreshKind(row.kind)) throw new Error('The stored Search refresh kind is invalid.');
    const changed = await this.db
      .update(searchPendingRefreshes)
      .set({ claimToken: token, claimDeadline: deadline, updatedAt: new Date() })
      .where(
        and(
          eq(searchPendingRefreshes.generationId, generationId),
          eq(searchPendingRefreshes.organizationId, row.organizationId),
          eq(searchPendingRefreshes.resourceKind, row.kind),
          eq(searchPendingRefreshes.sourceId, row.sourceId),
          isNull(searchPendingRefreshes.claimToken),
        ),
      )
      .returning({ revision: searchPendingRefreshes.revision });
    if (changed.length !== 1) throw new Error('The locked Search refresh changed unexpectedly.');
    return {
      generationId,
      organizationId: row.organizationId,
      kind: row.kind,
      sourceId: row.sourceId,
      revision: row.revision,
      token,
    };
  }

  /** Removes an applied revision or releases only the current token's pending work. */
  public async finish(
    claim: SearchRefreshClaim,
    result: 'applied' | 'released',
    retryAt?: Date,
  ): Promise<void> {
    const claimed = and(
      eq(searchPendingRefreshes.generationId, claim.generationId),
      eq(searchPendingRefreshes.organizationId, claim.organizationId),
      eq(searchPendingRefreshes.resourceKind, claim.kind),
      eq(searchPendingRefreshes.sourceId, claim.sourceId),
      eq(searchPendingRefreshes.claimToken, claim.token),
    );
    if (result === 'applied') {
      const deleted = await this.db
        .delete(searchPendingRefreshes)
        .where(and(claimed, eq(searchPendingRefreshes.revision, claim.revision)))
        .returning({ generationId: searchPendingRefreshes.generationId });
      if (deleted.length === 1) return;
    }
    await this.db
      .update(searchPendingRefreshes)
      .set({
        claimToken: null,
        claimDeadline: null,
        nextAttemptAt: retryAt ?? null,
        updatedAt: new Date(),
      })
      .where(claimed);
  }
  // #endregion
}

function isRefreshKind(kind: string): kind is SearchRefreshTarget['kind'] {
  return (
    kind === 'task' ||
    kind === 'list' ||
    kind === 'space' ||
    kind === 'document' ||
    kind === 'storage'
  );
}
