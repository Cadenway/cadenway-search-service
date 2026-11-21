import { describe, expect, it, vi } from 'vitest';

import type { SearchRebuildBrokerProgress } from '../../../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';
import type { SearchRebuildGeneration } from '../../../../models/rebuild/search-rebuild-generation.model.js';
import type { SearchRebuildPromotionTransaction } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-promotion-transaction.port.js';

import { PromoteSearchRebuild } from './promote-search-rebuild.use-case.js';

const createdAt = '2026-11-20T13:05:00.100Z';
const broker: SearchRebuildBrokerProgress = {
  stream: 'EVENTS',
  createdAt: '2026-11-20T13:00:00.000001Z',
  firstSequence: 1,
  lastSequence: 28,
  retainedGapCount: 0,
  consumers: [
    {
      handler: 'task-updated',
      createdAt: '2026-11-20T13:02:00.000001Z',
      deliveredSequence: 23,
      ackFloorSequence: 23,
      pending: 0,
      ackPending: 0,
    },
  ],
};
const candidate: SearchRebuildGeneration = {
  id: '019a9ee9-5290-7d6c-9cd2-c7fcfc138556',
  indexUid: 'search_019a9ee952907d6c9cd2c7fcfc138556',
  engineCreatedAt: createdAt,
  status: 'building',
  brokerAtStart: { ...broker, lastSequence: 24 },
};
const input = { generationId: candidate.id, engineCreatedAt: createdAt, broker };

function fixture(options: { readonly pending?: boolean; readonly active?: boolean } = {}) {
  const findGeneration = vi.fn<SearchRebuildPromotionTransaction['findGeneration']>();
  findGeneration.mockResolvedValue(
    options.active === true ? { ...candidate, status: 'active' } : candidate,
  );
  const readCoverage = vi.fn<SearchRebuildPromotionTransaction['readCoverage']>();
  readCoverage.mockResolvedValue({
    sourceCheckpoints: [
      { source: 'organization', complete: true },
      { source: 'task', complete: true },
      { source: 'list', complete: true },
      { source: 'space', complete: true },
      { source: 'document', complete: true },
      { source: 'storage', complete: true },
    ],
    hasPendingRefreshes: options.pending === true,
    terminalAdvisoriesClear: true,
  });
  const activate = vi.fn<SearchRebuildPromotionTransaction['activate']>();
  activate.mockResolvedValue(undefined);
  const execute = new PromoteSearchRebuild({
    run: async (work) => work({ findGeneration, readCoverage, activate }),
  });
  return { execute, readCoverage, activate };
}

describe('PromoteSearchRebuild', () => {
  it('certifies the observed global frontier after the stored queue drains', async () => {
    const { execute, readCoverage, activate } = fixture();

    await execute.execute(input);

    expect(readCoverage).toHaveBeenCalledWith(candidate);
    expect(activate).toHaveBeenCalledExactlyOnceWith(candidate.id, 28);
  });

  it('keeps the incumbent generation when a refresh has unconfirmed settlement', async () => {
    const { execute, activate } = fixture({ pending: true });

    await expect(execute.execute(input)).rejects.toThrow('lack confirmed success');
    expect(activate).not.toHaveBeenCalled();
  });

  it('accepts a retry after the same physical generation was already activated', async () => {
    const { execute, readCoverage, activate } = fixture({ active: true });

    await execute.execute(input);

    expect(readCoverage).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
