import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { eq } from 'drizzle-orm';

import type { SearchRefreshTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-refresh-transaction.port.js';
import type { SearchRefreshUnitOfWork } from '../../../../../application/ports/outbound/persistence/rebuild/search-refresh-unit-of-work.port.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import { DrizzleSearchRefreshRepository } from '../../repositories/rebuild/drizzle-search-refresh.repository.js';
import { searchRebuildControl } from '../../schemas/rebuild/search-rebuild.schema.js';

/** Serializes refresh recording and settlement with generation promotion. */
export class DrizzleSearchRefreshUnitOfWork implements SearchRefreshUnitOfWork {
  // #region Constructor
  /** Uses the shared system transaction runner. */
  public constructor(private readonly system: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Runs refresh work under the singleton rebuild control lock. */
  public async run<T>(work: (transaction: SearchRefreshTransaction) => Promise<T>): Promise<T> {
    return this.system.run(async (scope): Promise<T> => {
      const control = await scope.db
        .select({ id: searchRebuildControl.id })
        .from(searchRebuildControl)
        .where(eq(searchRebuildControl.id, 1))
        .for('update');
      if (control.length !== 1)
        throw new SearchRebuildPromotionError('The rebuild control row is missing.');
      return work(new DrizzleSearchRefreshRepository(scope.db));
    });
  }
  // #endregion
}
