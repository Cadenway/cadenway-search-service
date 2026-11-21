import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { eq } from 'drizzle-orm';

import type { SearchGenerationTransaction } from '../../../../../application/ports/outbound/persistence/rebuild/search-generation-transaction.port.js';
import type { SearchGenerationPort } from '../../../../../application/ports/outbound/persistence/rebuild/search-generation.port.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import { DrizzleSearchGenerationRepository } from '../../repositories/rebuild/drizzle-search-generation.repository.js';
import { searchRebuildControl } from '../../schemas/rebuild/search-rebuild.schema.js';

/** Serializes generation lifecycle work with export, promotion and refresh recording. */
export class DrizzleSearchGenerationUnitOfWork implements SearchGenerationPort {
  // #region Constructor
  /** Uses the kit system transaction runner. */
  public constructor(private readonly system: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Acquires the singleton control row before running database-only work. */
  public async run<T>(work: (transaction: SearchGenerationTransaction) => Promise<T>): Promise<T> {
    return this.system.run(async (scope): Promise<T> => {
      const control = await scope.db
        .select({ id: searchRebuildControl.id })
        .from(searchRebuildControl)
        .where(eq(searchRebuildControl.id, 1))
        .for('update');
      if (control.length !== 1)
        throw new SearchRebuildPromotionError('The rebuild control row is missing.');
      return work(new DrizzleSearchGenerationRepository(scope.db));
    });
  }
  // #endregion
}
