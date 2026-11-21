import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import { assertSearchRebuildPromotion } from '../../../../../domain/policies/rebuild/assert-search-rebuild-promotion.policy.js';
import type { SearchRebuildPromotionUnitOfWork } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-promotion-unit-of-work.port.js';

import type { PromoteSearchRebuildInput } from './promote-search-rebuild.input.js';

/** Promotes a complete search index while excluding concurrent generation and refresh recording. */
export class PromoteSearchRebuild {
  // #region Constructor
  /** Receives the promotion transaction boundary. */
  public constructor(private readonly unitOfWork: SearchRebuildPromotionUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Commits the active-generation switch only if the stored and sampled evidence agree. */
  public async execute(input: PromoteSearchRebuildInput): Promise<void> {
    await this.unitOfWork.run(async (transaction): Promise<void> => {
      const candidate = await transaction.findGeneration(input.generationId);
      if (candidate?.status === 'active' && candidate.engineCreatedAt === input.engineCreatedAt) {
        return;
      }
      if (candidate?.status !== 'building') {
        throw new SearchRebuildPromotionError('The search index generation is not a candidate.');
      }

      const coverage = await transaction.readCoverage(candidate);
      assertSearchRebuildPromotion({
        engineCreatedAtAtStart: candidate.engineCreatedAt ?? undefined,
        engineCreatedAtBeforePromotion: input.engineCreatedAt,
        sourceCheckpoints: coverage.sourceCheckpoints,
        meilisearchTasksSucceeded: !coverage.hasPendingRefreshes,
        invalidationsAppliedThroughSequence: coverage.hasPendingRefreshes
          ? -1
          : input.broker.lastSequence,
        terminalAdvisoriesClear: coverage.terminalAdvisoriesClear,
        brokerAtStart: candidate.brokerAtStart,
        brokerBeforePromotion: input.broker,
      });
      await transaction.activate(candidate.id, input.broker.lastSequence);
    });
  }
  // #endregion
}
