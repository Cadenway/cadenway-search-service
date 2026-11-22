import type { DatabaseSchema, TransactionDatabase } from '@cadenway/nest-common/database';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { SearchGenerationCheckpoint } from '../../../../../application/models/rebuild/search-generation-checkpoint.model.js';
import type { SearchGenerationRegistration } from '../../../../../application/models/rebuild/search-generation-registration.model.js';
import type { SearchRebuildGeneration } from '../../../../../application/models/rebuild/search-rebuild-generation.model.js';
import type { SearchGenerationTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-generation-transaction.port.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import {
  searchExportCheckpoints,
  searchIndexGenerations,
} from '../../schemas/rebuild/search-rebuild.schema.js';

/** Generation operations performed while the shared rebuild control row is locked. */
export class DrizzleSearchGenerationRepository implements SearchGenerationTransaction {
  // #region Constructor
  /** Receives the connection-bound transaction database. */
  public constructor(private readonly db: TransactionDatabase<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Reads the unique building generation. */
  public async findBuilding(): Promise<SearchRebuildGeneration | null> {
    const rows = await this.db
      .select({
        id: searchIndexGenerations.id,
        indexUid: searchIndexGenerations.indexUid,
        engineCreatedAt: searchIndexGenerations.engineCreatedAt,
        brokerAtStart: searchIndexGenerations.brokerAtStart,
      })
      .from(searchIndexGenerations)
      .where(eq(searchIndexGenerations.status, 'building'))
      .limit(1);
    const row = rows[0];
    return row ? { ...row, status: 'building' } : null;
  }

  /** Creates the candidate and its global roster position atomically. */
  public async register(input: SearchGenerationRegistration): Promise<SearchRebuildGeneration> {
    if (await this.findBuilding()) {
      throw new SearchRebuildPromotionError('A search index generation is already building.');
    }
    await this.db.insert(searchIndexGenerations).values({
      id: input.id,
      indexUid: input.indexUid,
      brokerAtStart: input.brokerAtStart,
      status: 'building',
    });
    await this.db
      .insert(searchExportCheckpoints)
      .values({ generationId: input.id, source: 'organization', organizationId: null });
    return {
      id: input.id,
      indexUid: input.indexUid,
      brokerAtStart: input.brokerAtStart,
      status: 'building',
      engineCreatedAt: null,
    };
  }

  /** Binds the identity exactly once or confirms an identical earlier binding. */
  public async bindIdentity(generationId: string, engineCreatedAt: string): Promise<boolean> {
    const changed = await this.db
      .update(searchIndexGenerations)
      .set({ engineCreatedAt, updatedAt: new Date() })
      .where(
        and(
          eq(searchIndexGenerations.id, generationId),
          eq(searchIndexGenerations.status, 'building'),
          isNull(searchIndexGenerations.engineCreatedAt),
        ),
      )
      .returning({ id: searchIndexGenerations.id });
    if (changed.length === 1) return true;
    const existing = await this.db
      .select({ id: searchIndexGenerations.id })
      .from(searchIndexGenerations)
      .where(
        and(
          eq(searchIndexGenerations.id, generationId),
          eq(searchIndexGenerations.status, 'building'),
          eq(searchIndexGenerations.engineCreatedAt, engineCreatedAt),
        ),
      )
      .limit(1);
    return existing.length === 1;
  }

  /** Abandons one building candidate or confirms an earlier abandonment. */
  public async abandon(generationId: string): Promise<boolean> {
    const changed = await this.db
      .update(searchIndexGenerations)
      .set({ status: 'abandoned', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(searchIndexGenerations.id, generationId),
          eq(searchIndexGenerations.status, 'building'),
        ),
      )
      .returning({ id: searchIndexGenerations.id });
    if (changed.length === 1) return true;
    const existing = await this.db
      .select({ id: searchIndexGenerations.id })
      .from(searchIndexGenerations)
      .where(
        and(
          eq(searchIndexGenerations.id, generationId),
          eq(searchIndexGenerations.status, 'abandoned'),
        ),
      )
      .limit(1);
    return existing.length === 1;
  }

  /** Returns the next incomplete export position after validating the candidate. */
  public async nextCheckpoint(generationId: string): Promise<SearchGenerationCheckpoint | null> {
    const generation = await this.db
      .select({ id: searchIndexGenerations.id })
      .from(searchIndexGenerations)
      .where(
        and(
          eq(searchIndexGenerations.id, generationId),
          eq(searchIndexGenerations.status, 'building'),
          isNotNull(searchIndexGenerations.engineCreatedAt),
        ),
      )
      .limit(1);
    if (generation.length !== 1)
      throw new SearchRebuildPromotionError('The search index candidate is not ready for export.');
    const roster = await this.db
      .select({ source: searchExportCheckpoints.source })
      .from(searchExportCheckpoints)
      .where(
        and(
          eq(searchExportCheckpoints.generationId, generationId),
          eq(searchExportCheckpoints.source, 'organization'),
          isNull(searchExportCheckpoints.organizationId),
        ),
      )
      .limit(1);
    if (roster.length !== 1)
      throw new SearchRebuildPromotionError('The search organization checkpoint is missing.');
    const checkpoints = await this.db
      .select({
        source: searchExportCheckpoints.source,
        organizationId: searchExportCheckpoints.organizationId,
        cursor: searchExportCheckpoints.cursor,
        inFlightDeadline: searchExportCheckpoints.writeDeadline,
      })
      .from(searchExportCheckpoints)
      .where(
        and(
          eq(searchExportCheckpoints.generationId, generationId),
          eq(searchExportCheckpoints.complete, false),
        ),
      )
      .orderBy(
        sql`case when ${searchExportCheckpoints.source} = 'organization' then 0 else 1 end`,
        asc(searchExportCheckpoints.source),
        asc(searchExportCheckpoints.organizationId),
      )
      .limit(1);
    const row = checkpoints[0];
    if (!row) return null;
    if (!isCheckpointSource(row.source))
      throw new SearchRebuildPromotionError('The search export source is invalid.');
    return { ...row, source: row.source };
  }
  // #endregion
}

function isCheckpointSource(source: string): source is SearchGenerationCheckpoint['source'] {
  return (
    source === 'organization' ||
    source === 'task' ||
    source === 'list' ||
    source === 'space' ||
    source === 'document' ||
    source === 'storage'
  );
}
