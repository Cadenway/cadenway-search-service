import type { SearchRefreshUnitOfWork } from '../../../../ports/outbound/persistence/rebuild/search-refresh-unit-of-work.port.js';

import type { RecordSearchRefreshesInput } from './record-search-refreshes.input.js';

/** Persists the resources an event invalidates before the broker can acknowledge it. */
export class RecordSearchRefreshes {
  // #region Constructor
  /** Receives the transactional queue. */
  public constructor(private readonly unitOfWork: SearchRefreshUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Holds the generation boundary until the refresh locators commit. */
  public async execute(input: RecordSearchRefreshesInput): Promise<void> {
    if (!Number.isSafeInteger(input.brokerSequence) || input.brokerSequence < 1) {
      throw new RangeError('The Search invalidation stream sequence must be a positive integer.');
    }
    if (input.targets.length > 100) {
      throw new RangeError('A Search invalidation can record at most 100 locators.');
    }
    if (input.targets.length === 0) return;
    await this.unitOfWork.run((transaction) =>
      transaction.enqueue(input.eventId, input.targets, input.brokerSequence),
    );
  }
  // #endregion
}
