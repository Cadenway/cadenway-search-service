import { describe, expect, it } from 'vitest';

import { SearchRebuildPromotionError } from '../../errors/rebuild/search-rebuild-promotion.error.js';
import type { SearchRebuildBrokerProgress } from '../../value-objects/rebuild/search-rebuild-broker-progress.value-object.js';
import type { SearchRebuildPromotionEvidence } from '../../value-objects/rebuild/search-rebuild-promotion-evidence.value-object.js';
import { assertSearchRebuildPromotion } from './assert-search-rebuild-promotion.policy.js';

const createdAt = '2026-11-21T10:00:00.123456781Z';
const replacedAt = '2026-11-21T10:00:00.123456782Z';

const brokerAtStart: SearchRebuildBrokerProgress = {
  advisoryLatch: { createdAt, lastSequence: 0 },
  stream: 'EVENTS',
  createdAt,
  firstSequence: 1,
  lastSequence: 50,
  retainedGapCount: 0,
  consumers: [
    {
      handler: 'search-document-updated',
      createdAt,
      deliveredSequence: 40,
      ackFloorSequence: 39,
      pending: 2,
      ackPending: 1,
    },
    {
      handler: 'search-task-updated',
      createdAt,
      deliveredSequence: 0,
      ackFloorSequence: 0,
      pending: 0,
      ackPending: 0,
    },
  ],
};

const documentAtPromotion = {
  handler: 'search-document-updated',
  createdAt,
  deliveredSequence: 53,
  ackFloorSequence: 53,
  pending: 0,
  ackPending: 0,
};
const taskAtPromotion = {
  ...documentAtPromotion,
  handler: 'search-task-updated',
  deliveredSequence: 0,
  ackFloorSequence: 0,
};
const brokerBeforePromotion: SearchRebuildBrokerProgress = {
  ...brokerAtStart,
  firstSequence: 51,
  lastSequence: 60,
  consumers: [taskAtPromotion, documentAtPromotion],
};

const evidence: SearchRebuildPromotionEvidence = {
  engineCreatedAtAtStart: createdAt,
  engineCreatedAtBeforePromotion: createdAt,
  sourceCheckpoints: [
    { source: 'organization', complete: true },
    { source: 'task', complete: true },
    { source: 'list', complete: true },
    { source: 'space', complete: true },
    { source: 'document', complete: true },
    { source: 'storage', complete: true },
  ],
  meilisearchTasksSucceeded: true,
  invalidationsAppliedThroughSequence: 60,
  terminalAdvisoriesClear: true,
  brokerAtStart,
  brokerBeforePromotion,
};

describe('assertSearchRebuildPromotion', () => {
  it('accepts certified global coverage when exact-filter durables acknowledge lower sequences', () => {
    expect(() => {
      assertSearchRebuildPromotion(evidence);
    }).not.toThrow();
  });

  it('accepts an empty JetStream whose retention floor is one beyond its last sequence', () => {
    const empty: SearchRebuildBrokerProgress = {
      ...brokerBeforePromotion,
      firstSequence: 1,
      lastSequence: 0,
      consumers: [taskAtPromotion],
    };

    expect(() => {
      assertSearchRebuildPromotion({
        ...evidence,
        invalidationsAppliedThroughSequence: 0,
        brokerAtStart: empty,
        brokerBeforePromotion: empty,
      });
    }).not.toThrow();
  });

  it('accepts a delivery after the observation of the stream high-water sequence', () => {
    expect(() => {
      assertSearchRebuildPromotion({
        ...evidence,
        brokerBeforePromotion: {
          ...brokerBeforePromotion,
          consumers: [
            taskAtPromotion,
            { ...documentAtPromotion, deliveredSequence: 61, ackFloorSequence: 61 },
          ],
        },
      });
    }).not.toThrow();
  });

  it('invalidates a legacy baseline without a latch observation', () => {
    expect(() => {
      assertSearchRebuildPromotion({
        ...evidence,
        brokerAtStart: { ...brokerAtStart, advisoryLatch: undefined },
      });
    }).toThrow(expect.objectContaining({ reason: 'invalidated' }));
  });

  it('waits when the final latch observation is unknown', () => {
    expect(() => {
      assertSearchRebuildPromotion({
        ...evidence,
        brokerBeforePromotion: { ...brokerBeforePromotion, advisoryLatch: undefined },
      });
    }).toThrow(expect.objectContaining({ reason: 'not-ready' }));
  });

  it('refuses promotion without evidence', () => {
    expect(() => {
      assertSearchRebuildPromotion(undefined);
    }).toThrow(SearchRebuildPromotionError);
  });

  it('invalidates the candidate when the physical index was replaced within the same millisecond', () => {
    expect(() => {
      assertSearchRebuildPromotion({ ...evidence, engineCreatedAtBeforePromotion: replacedAt });
    }).toThrow(expect.objectContaining({ reason: 'invalidated' }));
  });

  it.each<[string, Partial<SearchRebuildPromotionEvidence>]>([
    ['the physical index identity is unavailable', { engineCreatedAtAtStart: undefined }],
    [
      'the current physical index identity is malformed',
      { engineCreatedAtBeforePromotion: 'unknown' },
    ],
    [
      'the physical index identities are malformed',
      { engineCreatedAtAtStart: 'identical', engineCreatedAtBeforePromotion: 'identical' },
    ],
    [
      'the physical index identity has an impossible calendar date',
      {
        engineCreatedAtAtStart: '2026-02-30T10:00:00Z',
        engineCreatedAtBeforePromotion: '2026-02-30T10:00:00Z',
      },
    ],
    ['a source checkpoint is missing', { sourceCheckpoints: evidence.sourceCheckpoints.slice(1) }],
    [
      'a source checkpoint is duplicated',
      {
        sourceCheckpoints: [
          ...evidence.sourceCheckpoints.slice(1),
          { source: 'storage', complete: true },
        ],
      },
    ],
    [
      'a source scan is unfinished',
      {
        sourceCheckpoints: [
          ...evidence.sourceCheckpoints.slice(1),
          { source: 'organization', complete: false },
        ],
      },
    ],
    ['some Meilisearch tasks have no confirmed success', { meilisearchTasksSucceeded: false }],
    [
      'the certified invalidation frontier is behind the observation',
      { invalidationsAppliedThroughSequence: 59 },
    ],
    ['the invalidation frontier is malformed', { invalidationsAppliedThroughSequence: Number.NaN }],
    ['terminal advisories are unresolved', { terminalAdvisoriesClear: false }],
    ['the starting broker observation is missing', { brokerAtStart: undefined }],
    ['the final broker observation is missing', { brokerBeforePromotion: undefined }],
  ])('waits to promote when %s', (_reason, override) => {
    expect(() => {
      assertSearchRebuildPromotion({ ...evidence, ...override });
    }).toThrow(expect.objectContaining({ reason: 'not-ready' }));
  });

  it.each<[string, Partial<SearchRebuildBrokerProgress>]>([
    ['an advisory was recorded and cleared', { advisoryLatch: { createdAt, lastSequence: 1 } }],
    [
      'the advisory latch was recreated',
      { advisoryLatch: { createdAt: replacedAt, lastSequence: 0 } },
    ],
    ['the event stream name changed', { stream: 'OTHER_EVENTS' }],
    ['the event stream was recreated', { createdAt: replacedAt }],
    ['the retention floor crossed the start of the scan', { firstSequence: 52 }],
    ['the retention floor regressed', { firstSequence: 0 }],
    ['the stream sequence regressed', { firstSequence: 1, lastSequence: 49 }],
    ['the number of retained holes changed', { retainedGapCount: 1 }],
    ['a consumer is missing', { consumers: [documentAtPromotion] }],
    [
      'the handler set changed',
      { consumers: [documentAtPromotion, { ...taskAtPromotion, handler: 'different' }] },
    ],
    [
      'a consumer was recreated',
      { consumers: [taskAtPromotion, { ...documentAtPromotion, createdAt: replacedAt }] },
    ],
    [
      'a consumer delivery regressed',
      {
        consumers: [
          taskAtPromotion,
          { ...documentAtPromotion, deliveredSequence: 39, ackFloorSequence: 39 },
        ],
      },
    ],
    [
      'a consumer acknowledgement floor regressed',
      { consumers: [taskAtPromotion, { ...documentAtPromotion, ackFloorSequence: 38 }] },
    ],
  ])('invalidates the candidate when %s', (_reason, override) => {
    expect(() => {
      assertSearchRebuildPromotion({
        ...evidence,
        brokerBeforePromotion: { ...brokerBeforePromotion, ...override },
      });
    }).toThrow(expect.objectContaining({ reason: 'invalidated' }));
  });

  it.each<[string, Partial<SearchRebuildBrokerProgress>]>([
    ['the consumer list is empty', { consumers: [] }],
    ['a consumer is duplicated', { consumers: [documentAtPromotion, documentAtPromotion] }],
    [
      'the acknowledgement floor is ahead of delivery',
      { consumers: [taskAtPromotion, { ...documentAtPromotion, ackFloorSequence: 54 }] },
    ],
    [
      'a consumer has messages left to deliver',
      { consumers: [taskAtPromotion, { ...documentAtPromotion, pending: 1 }] },
    ],
    [
      'a consumer has messages awaiting acknowledgement',
      { consumers: [taskAtPromotion, { ...documentAtPromotion, ackPending: 1 }] },
    ],
    ['the stream sequence is unsafe', { lastSequence: Number.MAX_SAFE_INTEGER + 1 }],
  ])('waits to promote when %s', (_reason, override) => {
    expect(() => {
      assertSearchRebuildPromotion({
        ...evidence,
        brokerBeforePromotion: { ...brokerBeforePromotion, ...override },
      });
    }).toThrow(expect.objectContaining({ reason: 'not-ready' }));
  });

  it('invalidates on a consumer replacement even if another consumer and the local work are pending', () => {
    expect(() => {
      assertSearchRebuildPromotion({
        ...evidence,
        meilisearchTasksSucceeded: false,
        brokerBeforePromotion: {
          ...brokerBeforePromotion,
          consumers: [
            { ...taskAtPromotion, pending: 1 },
            { ...documentAtPromotion, createdAt: replacedAt },
          ],
        },
      });
    }).toThrow(expect.objectContaining({ reason: 'invalidated' }));
  });
});
