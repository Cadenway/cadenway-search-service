import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { eq } from 'drizzle-orm';

import type { SearchRebuildExportTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-rebuild-export-transaction.port.js';
import type { SearchRebuildExportPort } from '../../../../../application/ports/outbound/persistence/rebuild/search-rebuild-export.port.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import { DrizzleSearchRebuildExportRepository } from '../../repositories/rebuild/drizzle-search-rebuild-export.repository.js';
import { searchRebuildControl } from '../../schemas/rebuild/search-rebuild.schema.js';

/** Serializes export checkpoints with generation promotion and refresh recording. */
export class DrizzleSearchRebuildExportUnitOfWork implements SearchRebuildExportPort {
  // #region Constructor
  /** Uses the shared system transaction runner. */
  public constructor(private readonly system: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Runs checkpoint work under the singleton rebuild control lock. */
  public async run<T>(
    work: (transaction: SearchRebuildExportTransaction) => Promise<T>,
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
      return work(new DrizzleSearchRebuildExportRepository(scope.db));
    });
  }
  // #endregion
}
