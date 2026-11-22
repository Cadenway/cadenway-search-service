import type { SearchPrunableGeneration } from '../../../../models/rebuild/search-prunable-generation.model.js';

/** Removes a drained physical index and records confirmation outside the engine call. */
export class PruneSearchGeneration {
  // #region Constructor
  /** Binds database claims and identity-checked engine deletion. */
  public constructor(
    private readonly store: {
      readonly claimExpiredGeneration: () => Promise<SearchPrunableGeneration | null>;
      readonly markGenerationPurged: (generation: SearchPrunableGeneration) => Promise<void>;
    },
    private readonly engine: {
      readonly removeGeneration: (
        indexUid: string,
        engineCreatedAt: string,
        signal?: AbortSignal,
      ) => Promise<void>;
    },
  ) {}
  // #endregion

  // #region Methods
  /** Attempts one purge. An interrupted or uncertain outcome becomes eligible again. */
  public async execute(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const generation = await this.store.claimExpiredGeneration();
    if (generation === null) return;
    await this.engine.removeGeneration(generation.indexUid, generation.engineCreatedAt, signal);
    await this.store.markGenerationPurged(generation);
  }
  // #endregion
}
