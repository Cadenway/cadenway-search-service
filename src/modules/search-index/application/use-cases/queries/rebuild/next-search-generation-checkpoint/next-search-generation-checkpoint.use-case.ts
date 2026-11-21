import type { SearchGenerationPort } from '../../../../ports/outbound/persistence/rebuild/search-generation.port.js';

import type { NextSearchGenerationCheckpointInput } from './next-search-generation-checkpoint.input.js';
import type { NextSearchGenerationCheckpointOutput } from './next-search-generation-checkpoint.output.js';

/** Selects one unfinished authoritative export with deterministic ordering. */
export class NextSearchGenerationCheckpoint {
  // #region Constructor
  /** Receives the database-only generation transaction. */
  public constructor(private readonly unitOfWork: SearchGenerationPort) {}
  // #endregion

  // #region Methods
  /** Reads the next checkpoint while holding the generation control lock. */
  public async execute(
    input: NextSearchGenerationCheckpointInput,
  ): Promise<NextSearchGenerationCheckpointOutput> {
    if (input.generationId.length === 0) throw new Error('Invalid search generation identifier.');
    return this.unitOfWork.run((transaction) => transaction.nextCheckpoint(input.generationId));
  }
  // #endregion
}
