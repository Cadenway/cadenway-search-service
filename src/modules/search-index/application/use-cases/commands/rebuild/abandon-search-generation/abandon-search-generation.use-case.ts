import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import type { AbandonSearchGenerationInput } from './abandon-search-generation.input.js';

/** Abandons a generation whose physical creation or identity cannot be established. */
export class AbandonSearchGeneration {
  // #region Constructor
  /** Receives the database-only generation transaction. */
  public constructor(private readonly unitOfWork: SearchGenerationPort) {}
  // #endregion

  // #region Methods
  /** Makes abandonment retryable while preserving the active generation. */
  public async execute(input: AbandonSearchGenerationInput): Promise<void> {
    if (input.generationId.length === 0) throw new Error('Invalid search generation identifier.');
    await this.unitOfWork.run(async (transaction): Promise<void> => {
      if (!(await transaction.abandon(input.generationId))) {
        throw new Error('Search generation cannot be abandoned.');
      }
    });
  }
  // #endregion
}
