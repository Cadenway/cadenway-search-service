import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { eq } from 'drizzle-orm';

import type { SearchRebuildPromotionTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-rebuild-promotion-transaction.port.js';
import type { SearchRebuildPromotionUnitOfWork } from '../../../../../application/ports/outbound/persistence/rebuild/search-rebuild-promotion-unit-of-work.port.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import { DrizzleSearchRebuildPromotionRepository } from '../../repositories/rebuild/drizzle-search-rebuild-promotion.repository.js';
import { searchRebuildControl } from '../../schemas/rebuild/search-rebuild.schema.js';

/** Serializes promotion with generation lifecycle and durable invalidation recording. */
export class DrizzleSearchRebuildPromotionUnitOfWork implements SearchRebuildPromotionUnitOfWork {
  // #region Constructor
  /** Uses the kit system runner for the global rebuild control boundary. */
  public constructor(private readonly system: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Runs database work after acquiring the singleton control lock. */
  public async run<T>(
    work: (transaction: SearchRebuildPromotionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.system.run(async (scope): Promise<T> => {
      const control = await scope.db
        .select({ id: searchRebuildControl.id })
        .from(searchRebuildControl)
        .where(eq(searchRebuildControl.id, 1))
        .for('update');
      if (control.length !== 1) {
        throw new SearchRebuildPromotionError('The rebuild control row is missing.');
      }
      return work(new DrizzleSearchRebuildPromotionRepository(scope.db));
    });
  }
  // #endregion
}
