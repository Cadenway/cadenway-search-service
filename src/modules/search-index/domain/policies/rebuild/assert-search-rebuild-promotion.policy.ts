import { SearchRebuildPromotionError } from '../../errors/rebuild/search-rebuild-promotion.error.js';
import type { SearchRebuildBrokerProgress } from '../../value-objects/rebuild/search-rebuild-broker-progress.value-object.js';
import type { SearchRebuildPromotionEvidence } from '../../value-objects/rebuild/search-rebuild-promotion-evidence.value-object.js';

const requiredSourceProjections = new Set([
  'organization',
  'task',
  'list',
  'space',
  'document',
  'storage',
]);

const creationTimestamp =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Refuses candidate promotion until its source scans, physical writes and durable catch-up are proven.
 * See the P5 rebuild decision in `.handover/plan.md` and the Search Index module invariants.
 *
 * @throws {SearchRebuildPromotionError} A confirmed loss invalidates the candidate. Incomplete or
 * malformed evidence leaves it eligible for a later check.
 */
export function assertSearchRebuildPromotion(
  evidence: SearchRebuildPromotionEvidence | undefined,
): void {
  if (!evidence) {
    throw new SearchRebuildPromotionError('Promotion evidence is missing.');
  }

  const hasEngineIdentities =
    isCreationTimestamp(evidence.engineCreatedAtAtStart) &&
    isCreationTimestamp(evidence.engineCreatedAtBeforePromotion);
  if (
    hasEngineIdentities &&
    evidence.engineCreatedAtAtStart !== evidence.engineCreatedAtBeforePromotion
  ) {
    throw new SearchRebuildPromotionError(
      'The physical index identity has changed.',
      'invalidated',
    );
  }

  const start = evidence.brokerAtStart;
  const current = evidence.brokerBeforePromotion;
  assertBrokerProgress(start);
  assertBrokerProgress(current);

  // Source data covers the prefix observed before the scans opened. Losing a later position can
  // hide a change the scans missed. Consumer positions never need to reach the stream-wide head.
  if (
    current.stream !== start.stream ||
    current.createdAt !== start.createdAt ||
    current.firstSequence < start.firstSequence ||
    current.lastSequence < start.lastSequence ||
    current.firstSequence - 1 > start.lastSequence ||
    current.retainedGapCount !== start.retainedGapCount
  ) {
    throw new SearchRebuildPromotionError('Event stream continuity was lost.', 'invalidated');
  }

  assertConsumerContinuity(start.consumers, current.consumers);

  if (!hasEngineIdentities) {
    throw new SearchRebuildPromotionError('The physical index identity is missing or invalid.');
  }

  assertSourceCheckpoints(evidence.sourceCheckpoints);

  if (!isConfirmed(evidence.meilisearchTasksSucceeded)) {
    throw new SearchRebuildPromotionError('Some physical index tasks lack confirmed success.');
  }
  if (!isConfirmed(evidence.terminalAdvisoriesClear)) {
    throw new SearchRebuildPromotionError('Terminal advisory clearance is missing.');
  }
  if (current.consumers.some((consumer) => consumer.pending !== 0 || consumer.ackPending !== 0)) {
    throw new SearchRebuildPromotionError('Durable consumers still have pending work.');
  }
  if (
    !isSequence(evidence.invalidationsAppliedThroughSequence) ||
    evidence.invalidationsAppliedThroughSequence < current.lastSequence
  ) {
    throw new SearchRebuildPromotionError(
      'Durable invalidations do not cover the observed frontier.',
    );
  }
}

function assertSourceCheckpoints(
  checkpoints: readonly (SearchRebuildPromotionEvidence['sourceCheckpoints'][number] | undefined)[],
): void {
  if (!isArray(checkpoints) || checkpoints.length !== requiredSourceProjections.size) {
    throw new SearchRebuildPromotionError('An authoritative projection checkpoint is missing.');
  }

  const remaining = new Set(requiredSourceProjections);
  for (const checkpoint of checkpoints) {
    if (!checkpoint || !isConfirmed(checkpoint.complete) || !remaining.delete(checkpoint.source)) {
      throw new SearchRebuildPromotionError(
        'Authoritative projection checkpoints are incomplete or invalid.',
      );
    }
  }
}

function assertBrokerProgress(
  progress: SearchRebuildBrokerProgress | undefined,
): asserts progress is SearchRebuildBrokerProgress {
  if (
    !progress ||
    !isName(progress.stream) ||
    !isCreationTimestamp(progress.createdAt) ||
    !isSequence(progress.firstSequence) ||
    !isSequence(progress.lastSequence) ||
    !isSequence(progress.retainedGapCount) ||
    progress.firstSequence - 1 > progress.lastSequence ||
    !isArray(progress.consumers) ||
    progress.consumers.length === 0
  ) {
    throw new SearchRebuildPromotionError('The event stream observation is missing or invalid.');
  }

  const handlers = new Set<string>();
  const consumers: readonly (SearchRebuildBrokerProgress['consumers'][number] | undefined)[] =
    progress.consumers;
  for (const consumer of consumers) {
    if (
      !consumer ||
      !isName(consumer.handler) ||
      !isCreationTimestamp(consumer.createdAt) ||
      !isSequence(consumer.deliveredSequence) ||
      !isSequence(consumer.ackFloorSequence) ||
      !isSequence(consumer.pending) ||
      !isSequence(consumer.ackPending) ||
      consumer.ackFloorSequence > consumer.deliveredSequence ||
      handlers.has(consumer.handler)
    ) {
      throw new SearchRebuildPromotionError('The durable consumer observations are invalid.');
    }
    handlers.add(consumer.handler);
  }
}

function assertConsumerContinuity(
  start: SearchRebuildBrokerProgress['consumers'],
  current: SearchRebuildBrokerProgress['consumers'],
): void {
  if (start.length !== current.length) {
    throw new SearchRebuildPromotionError(
      'The observed durable consumer set has changed.',
      'invalidated',
    );
  }

  const startByHandler = new Map(start.map((consumer) => [consumer.handler, consumer]));
  for (const consumer of current) {
    const original = startByHandler.get(consumer.handler);
    if (
      original?.createdAt !== consumer.createdAt ||
      consumer.deliveredSequence < original.deliveredSequence ||
      consumer.ackFloorSequence < original.ackFloorSequence
    ) {
      throw new SearchRebuildPromotionError('Durable consumer continuity was lost.', 'invalidated');
    }
  }
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isConfirmed(value: unknown): boolean {
  return value === true;
}

function isName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.trim() === name;
}

function isCreationTimestamp(timestamp: string | undefined): boolean {
  if (
    typeof timestamp !== 'string' ||
    !creationTimestamp.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    return false;
  }

  // Date.parse normalizes out-of-range days within some months.
  const date = timestamp.slice(0, 10);
  return new Date(date).toISOString().slice(0, 10) === date;
}

function isSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0;
}
