import type { DatabaseSchema, TransactionDatabase } from '@cadenway/nest-common/database';
import { and, eq, exists, isNotNull, isNull, sql } from 'drizzle-orm';

import type { SearchGenerationCheckpoint } from '../../../../../application/models/rebuild/search-generation-checkpoint.model.js';
import type { SearchRebuildExportClaim } from '../../../../../application/models/rebuild/search-rebuild-export-claim.model.js';
import type { SearchRebuildExportPage } from '../../../../../application/models/rebuild/search-rebuild-export-page.model.js';
import type { SearchRebuildExportPosition } from '../../../../../application/models/rebuild/search-rebuild-export-position.model.js';
import type { SearchRebuildExportRosterPage } from '../../../../../application/models/rebuild/search-rebuild-export-roster-page.model.js';
import type { SearchRebuildExportTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-rebuild-export-transaction.port.js';
import {
  searchExportCheckpoints,
  searchIndexGenerations,
} from '../../schemas/rebuild/search-rebuild.schema.js';

const tenantSources = ['task', 'list', 'space', 'document', 'storage'] as const;
type PageResult = 'applied' | 'already-applied' | 'stale';

/** Records source positions while the rebuild control row is locked. */
export class DrizzleSearchRebuildExportRepository implements SearchRebuildExportTransaction {
  // #region Constructor
  /** Binds the repository to the current system transaction. */
  public constructor(private readonly db: TransactionDatabase<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Claims an incomplete tenant checkpoint without replacing an expired intent. */
  public async claimExportPage(
    input: SearchRebuildExportClaim,
  ): Promise<'claimed' | 'occupied' | 'expired' | 'stale'> {
    const scope = and(
      eq(searchExportCheckpoints.generationId, input.generationId),
      eq(searchExportCheckpoints.source, input.source),
      eq(searchExportCheckpoints.organizationId, input.organizationId),
    );
    const rows = await this.db
      .select({
        cursor: searchExportCheckpoints.cursor,
        complete: searchExportCheckpoints.complete,
        writeToken: searchExportCheckpoints.writeToken,
        expired: sql<boolean>`${searchExportCheckpoints.writeDeadline} <= clock_timestamp()`,
      })
      .from(searchExportCheckpoints)
      .innerJoin(
        searchIndexGenerations,
        eq(searchIndexGenerations.id, searchExportCheckpoints.generationId),
      )
      .where(
        and(
          scope,
          eq(searchIndexGenerations.status, 'building'),
          isNotNull(searchIndexGenerations.engineCreatedAt),
        ),
      )
      .limit(1);
    const current = rows[0];
    if (!current || current.complete || current.cursor !== input.expectedCursor) return 'stale';
    if (current.writeToken !== null) return current.expired ? 'expired' : 'occupied';
    const changed = await this.db
      .update(searchExportCheckpoints)
      .set({
        writeToken: input.claimToken,
        writeDeadline: input.claimDeadline,
        updatedAt: new Date(),
      })
      .where(
        and(
          scope,
          eq(searchExportCheckpoints.complete, false),
          isNull(searchExportCheckpoints.writeToken),
          input.expectedCursor === null
            ? isNull(searchExportCheckpoints.cursor)
            : eq(searchExportCheckpoints.cursor, input.expectedCursor),
          sql`${input.claimDeadline} > clock_timestamp()`,
        ),
      )
      .returning({ generationId: searchExportCheckpoints.generationId });
    return changed.length === 1 ? 'claimed' : 'stale';
  }

  /** Delays a matching incomplete position without claiming any physical write. */
  public async deferCheckpoint(
    generationId: string,
    checkpoint: SearchGenerationCheckpoint,
    retryAt: Date,
  ): Promise<void> {
    const building = this.db
      .select({ id: searchIndexGenerations.id })
      .from(searchIndexGenerations)
      .where(
        and(
          eq(searchIndexGenerations.id, generationId),
          eq(searchIndexGenerations.status, 'building'),
        ),
      );
    await this.db
      .update(searchExportCheckpoints)
      .set({ nextAttemptAt: retryAt, updatedAt: sql`statement_timestamp()` })
      .where(
        and(
          eq(searchExportCheckpoints.generationId, generationId),
          eq(searchExportCheckpoints.source, checkpoint.source),
          checkpoint.organizationId === null
            ? isNull(searchExportCheckpoints.organizationId)
            : eq(searchExportCheckpoints.organizationId, checkpoint.organizationId),
          checkpoint.cursor === null
            ? isNull(searchExportCheckpoints.cursor)
            : eq(searchExportCheckpoints.cursor, checkpoint.cursor),
          eq(searchExportCheckpoints.complete, false),
          isNull(searchExportCheckpoints.writeToken),
          exists(building),
        ),
      );
  }

  /** Advances a single tenant's source checkpoint. */
  public async recordExportPage(input: SearchRebuildExportPage): Promise<PageResult> {
    return this.advance(input, input.source, input.organizationId, input.claimToken);
  }

  /** Advances the roster and creates all tenant checkpoints in the same transaction. */
  public async recordRosterPage(input: SearchRebuildExportRosterPage): Promise<PageResult> {
    const result = await this.advance(input, 'organization', null);
    if (result !== 'applied') return result;

    const checkpoints = input.organizationIds.flatMap((organizationId) =>
      tenantSources.map((source) => ({ generationId: input.generationId, organizationId, source })),
    );
    if (checkpoints.length > 0) {
      await this.db.insert(searchExportCheckpoints).values(checkpoints).onConflictDoNothing();
    }
    return result;
  }

  private async advance(
    input: SearchRebuildExportPosition,
    source: SearchRebuildExportPage['source'] | 'organization',
    organizationId: string | null,
    claimToken?: string,
  ): Promise<PageResult> {
    const candidate = await this.db
      .select({ id: searchIndexGenerations.id })
      .from(searchIndexGenerations)
      .where(
        and(
          eq(searchIndexGenerations.id, input.generationId),
          eq(searchIndexGenerations.status, 'building'),
        ),
      )
      .limit(1);
    if (candidate.length !== 1) return 'stale';

    const scope = and(
      eq(searchExportCheckpoints.generationId, input.generationId),
      eq(searchExportCheckpoints.source, source),
      organizationId === null
        ? isNull(searchExportCheckpoints.organizationId)
        : eq(searchExportCheckpoints.organizationId, organizationId),
    );
    const rows = await this.db
      .select({
        cursor: searchExportCheckpoints.cursor,
        complete: searchExportCheckpoints.complete,
      })
      .from(searchExportCheckpoints)
      .where(scope)
      .limit(1);
    const current = rows[0];
    if (!current) return 'stale';

    const targetComplete = input.nextCursor === null;
    if (current.cursor === input.nextCursor && current.complete === targetComplete) {
      return 'already-applied';
    }
    if (current.complete || current.cursor !== input.expectedCursor) return 'stale';

    const changed = await this.db
      .update(searchExportCheckpoints)
      .set({
        cursor: input.nextCursor,
        complete: targetComplete,
        nextAttemptAt: null,
        writeToken: null,
        writeDeadline: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          scope,
          eq(searchExportCheckpoints.complete, false),
          input.expectedCursor === null
            ? isNull(searchExportCheckpoints.cursor)
            : eq(searchExportCheckpoints.cursor, input.expectedCursor),
          claimToken === undefined
            ? isNull(searchExportCheckpoints.writeToken)
            : and(
                eq(searchExportCheckpoints.writeToken, claimToken),
                sql`${searchExportCheckpoints.writeDeadline} > clock_timestamp()`,
              ),
        ),
      )
      .returning({ generationId: searchExportCheckpoints.generationId });
    return changed.length === 1 ? 'applied' : 'stale';
  }
  // #endregion
}
