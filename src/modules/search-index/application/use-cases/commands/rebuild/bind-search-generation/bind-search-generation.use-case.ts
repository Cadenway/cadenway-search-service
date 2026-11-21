import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import type { BindSearchGenerationInput } from './bind-search-generation.input.js';

/** Records a physical identity only if it has not changed. */
export class BindSearchGeneration {
  // #region Constructor
  /** Receives the database-only generation transaction. */
  public constructor(private readonly unitOfWork: SearchGenerationPort) {}
  // #endregion

  // #region Methods
  /** Binds or confirms the same identity for a building candidate. */
  public async execute(input: BindSearchGenerationInput): Promise<void> {
    if (input.generationId.length === 0 || input.engineCreatedAt.length === 0) {
      throw new Error('Invalid search generation identity.');
    }
    await this.unitOfWork.run(async (transaction): Promise<void> => {
      if (!(await transaction.bindIdentity(input.generationId, input.engineCreatedAt))) {
        throw new Error('Search generation identity changed.');
      }
    });
  }
  // #endregion
}
