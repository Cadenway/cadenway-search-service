import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import type { RegisterSearchGenerationInput } from './register-search-generation.input.js';
import type { RegisterSearchGenerationOutput } from './register-search-generation.output.js';

/** Registers a unique candidate and the initial roster checkpoint in one transaction. */
export class RegisterSearchGeneration {
  // #region Constructor
  /** Receives the database-only generation transaction. */
  public constructor(private readonly unitOfWork: SearchGenerationPort) {}
  // #endregion

  // #region Methods
  /** Returns the existing candidate or registers the caller's candidate. */
  public async execute(
    input: RegisterSearchGenerationInput,
  ): Promise<RegisterSearchGenerationOutput> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.generationId)
    ) {
      throw new Error('Invalid search generation identifier.');
    }
    return this.unitOfWork.run(async (transaction): Promise<RegisterSearchGenerationOutput> => {
      const existing = await transaction.findBuilding();
      if (existing !== null) return { generation: existing, newlyRegistered: false };
      const id = input.generationId.toLowerCase();
      const generation = await transaction.register({
        id,
        indexUid: `search_${id.replaceAll('-', '')}`,
        brokerAtStart: input.brokerAtStart,
      });
      return { generation, newlyRegistered: true };
    });
  }
  // #endregion
}
