import type { DatabaseSchema, TransactionDatabase } from '@cadenway/nest-common/database';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { SearchParentCheckpoint } from '../../../../../application/models/rebuild/search-parent-checkpoint.model.js';
import type { SearchRefreshClaim } from '../../../../../application/models/rebuild/search-refresh-claim.model.js';
import type { SearchRefreshTarget } from '../../../../../application/models/rebuild/search-refresh-target.model.js';
import {
  searchIndexGenerations,
  searchPendingRefreshes,
} from '../../schemas/rebuild/search-rebuild.schema.js';

/** Database operations for one parent reconciliation under the shared control lock. */
export class DrizzleSearchParentRepository {
  // #region Constructor
  /** Uses the current system transaction. */
  public constructor(private readonly db: TransactionDatabase<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Claims the oldest available parent without taking over expired claims. */
  public async claimNextParent(
    generationId: string,
    token: string,
    deadline: Date,
  ): Promise<{ claim: SearchRefreshClaim; checkpoint: SearchParentCheckpoint } | null> {
    const rows = await this.db
      .select({
        organizationId: searchPendingRefreshes.organizationId,
        kind: searchPendingRefreshes.resourceKind,
        sourceId: searchPendingRefreshes.sourceId,
        revision: searchPendingRefreshes.revision,
        phase: searchPendingRefreshes.cascadePhase,
        cursor: searchPendingRefreshes.cascadeCursor,
      })
      .from(searchPendingRefreshes)
      .innerJoin(
        searchIndexGenerations,
        eq(searchPendingRefreshes.generationId, searchIndexGenerations.id),
      )
      .where(
        and(
          eq(searchPendingRefreshes.generationId, generationId),
          inArray(searchPendingRefreshes.resourceKind, ['list', 'space']),
          isNull(searchPendingRefreshes.claimToken),
          inArray(searchIndexGenerations.status, ['active', 'building']),
          isNotNull(searchIndexGenerations.engineCreatedAt),
        ),
      )
      .orderBy(
        asc(searchPendingRefreshes.maxBrokerSequence),
        asc(searchPendingRefreshes.organizationId),
        asc(searchPendingRefreshes.resourceKind),
        asc(searchPendingRefreshes.sourceId),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.kind !== 'list' && row.kind !== 'space') throw new Error('Invalid Search parent kind.');
    const phase = row.phase ?? 'indexed';
    if (!isPhase(phase) || (phase === 'lists' && row.kind !== 'space'))
      throw new Error('Invalid Search parent checkpoint.');
    const changed = await this.db
      .update(searchPendingRefreshes)
      .set({
        claimToken: token,
        claimDeadline: deadline,
        cascadePhase: phase,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(searchPendingRefreshes.generationId, generationId),
          eq(searchPendingRefreshes.organizationId, row.organizationId),
          eq(searchPendingRefreshes.resourceKind, row.kind),
          eq(searchPendingRefreshes.sourceId, row.sourceId),
          isNull(searchPendingRefreshes.claimToken),
          sql`${deadline} > clock_timestamp()`,
        ),
      )
      .returning({ revision: searchPendingRefreshes.revision });
    if (changed.length !== 1) return null;
    return {
      claim: {
        generationId,
        organizationId: row.organizationId,
        kind: row.kind,
        sourceId: row.sourceId,
        revision: row.revision,
        token,
      },
      checkpoint: { phase, cursor: row.cursor },
    };
  }

  /** Records one bounded descendant page and advances the associated parent checkpoint. */
  public async advance(input: {
    readonly claim: SearchRefreshClaim;
    readonly expected: SearchParentCheckpoint;
    readonly next: SearchParentCheckpoint;
    readonly children: readonly SearchRefreshTarget[];
  }): Promise<'advanced' | 'stale' | 'restarted'> {
    const { claim, expected, next } = input;
    if (
      input.children.length > 100 ||
      input.children.some(
        (child) =>
          child.organizationId !== claim.organizationId ||
          (child.kind !== 'task' && (claim.kind !== 'space' || child.kind !== 'list')),
      )
    )
      throw new Error('Invalid Search parent descendant batch.');
    const parent = await this.readClaim(claim);
    if (!parent) return 'stale';
    if (parent.revision !== claim.revision) {
      await this.restart(claim);
      return 'restarted';
    }
    if (parent.phase !== expected.phase || parent.cursor !== expected.cursor) return 'stale';
    const children = [
      ...new Map(
        input.children.map((child) => [
          JSON.stringify([child.organizationId, child.kind, child.sourceId]),
          child,
        ]),
      ).values(),
    ];
    if (children.length > 0) {
      await this.db
        .insert(searchPendingRefreshes)
        .values(
          children.map((child) => ({
            generationId: claim.generationId,
            organizationId: child.organizationId,
            resourceKind: child.kind,
            sourceId: child.sourceId,
            maxBrokerSequence: parent.maxBrokerSequence,
          })),
        )
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
    await this.db
      .update(searchPendingRefreshes)
      .set({
        cascadePhase: next.phase,
        cascadeCursor: next.cursor,
        claimToken: null,
        claimDeadline: null,
        updatedAt: new Date(),
      })
      .where(this.claimScope(claim));
    return 'advanced';
  }

  /** Releases a token known not to have started a physical parent write. */
  public async release(claim: SearchRefreshClaim): Promise<void> {
    await this.db
      .update(searchPendingRefreshes)
      .set({ claimToken: null, claimDeadline: null, updatedAt: new Date() })
      .where(this.claimScope(claim));
  }

  /** Settles a physically confirmed parent or restarts it when a newer event arrived. */
  public async finish(
    claim: SearchRefreshClaim,
    expected: SearchParentCheckpoint,
  ): Promise<'applied' | 'stale' | 'restarted'> {
    const parent = await this.readClaim(claim);
    if (!parent) return 'stale';
    if (parent.revision !== claim.revision) {
      await this.restart(claim);
      return 'restarted';
    }
    if (
      parent.phase !== expected.phase ||
      parent.cursor !== expected.cursor ||
      expected.phase !== 'self'
    )
      return 'stale';
    await this.db
      .delete(searchPendingRefreshes)
      .where(and(this.claimScope(claim), eq(searchPendingRefreshes.revision, claim.revision)));
    return 'applied';
  }

  private claimScope(claim: SearchRefreshClaim) {
    return and(
      eq(searchPendingRefreshes.generationId, claim.generationId),
      eq(searchPendingRefreshes.organizationId, claim.organizationId),
      eq(searchPendingRefreshes.resourceKind, claim.kind),
      eq(searchPendingRefreshes.sourceId, claim.sourceId),
      eq(searchPendingRefreshes.claimToken, claim.token),
    );
  }

  private async readClaim(claim: SearchRefreshClaim) {
    if (claim.kind !== 'list' && claim.kind !== 'space') return null;
    const rows = await this.db
      .select({
        revision: searchPendingRefreshes.revision,
        phase: searchPendingRefreshes.cascadePhase,
        cursor: searchPendingRefreshes.cascadeCursor,
        maxBrokerSequence: searchPendingRefreshes.maxBrokerSequence,
      })
      .from(searchPendingRefreshes)
      .innerJoin(
        searchIndexGenerations,
        eq(searchPendingRefreshes.generationId, searchIndexGenerations.id),
      )
      .where(
        and(
          this.claimScope(claim),
          inArray(searchIndexGenerations.status, ['active', 'building']),
          isNotNull(searchIndexGenerations.engineCreatedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async restart(claim: SearchRefreshClaim): Promise<void> {
    await this.db
      .update(searchPendingRefreshes)
      .set({
        cascadePhase: 'indexed',
        cascadeCursor: null,
        claimToken: null,
        claimDeadline: null,
        updatedAt: new Date(),
      })
      .where(this.claimScope(claim));
  }
  // #endregion
}

function isPhase(phase: string): phase is SearchParentCheckpoint['phase'] {
  return phase === 'indexed' || phase === 'tasks' || phase === 'lists' || phase === 'self';
}
