import { SearchAuthorityReadError } from '../../../../../domain/errors/authority/search-authority-read.error.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import { nextSearchReadAttempt } from '../../../../../domain/policies/rebuild/search-read-retry.policy.js';
import type { SearchRebuildBrokerProgress } from '../../../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';
import type { SearchBrokerProgressReader } from '../../../../ports/outbound/messaging/rebuild/search-broker-progress-reader.port.js';
import type { SearchRebuildExportPort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-export.port.js';
import type { SearchRebuildRuntimePort } from '../../../../ports/outbound/persistence/rebuild/search-rebuild-runtime.port.js';
import type { SearchGenerationEnginePort } from '../../../../ports/outbound/search/rebuild/search-generation-engine.port.js';
import type { NextSearchGenerationCheckpoint } from '../../../queries/rebuild/next-search-generation-checkpoint/next-search-generation-checkpoint.use-case.js';
import type { AbandonSearchGeneration } from '../abandon-search-generation/abandon-search-generation.use-case.js';
import type { BindSearchGeneration } from '../bind-search-generation/bind-search-generation.use-case.js';
import type { IndexSearchExportPage } from '../index-search-export-page/index-search-export-page.use-case.js';
import type { PromoteSearchRebuild } from '../promote-search-rebuild/promote-search-rebuild.use-case.js';
import type { RefreshSearchProjection } from '../refresh-search-projection/refresh-search-projection.use-case.js';
import type { RegisterSearchGeneration } from '../register-search-generation/register-search-generation.use-case.js';

import type { RebuildSearchIndexStepInput } from './rebuild-search-index-step.input.js';
import type { RebuildSearchIndexStepOutput } from './rebuild-search-index-step.output.js';

const unboundTimeoutMs = 60_000;

/** Advances at most one physical export or refresh per invocation. */
export class RebuildSearchIndexStep {
  // #region Constructor
  /** Receives state readers and the existing bounded rebuild operations. */
  public constructor(
    private readonly runtime: SearchRebuildRuntimePort,
    private readonly engine: SearchGenerationEnginePort,
    private readonly broker: SearchBrokerProgressReader,
    private readonly register: Pick<RegisterSearchGeneration, 'execute'>,
    private readonly bind: Pick<BindSearchGeneration, 'execute'>,
    private readonly abandon: Pick<AbandonSearchGeneration, 'execute'>,
    private readonly nextCheckpoint: Pick<NextSearchGenerationCheckpoint, 'execute'>,
    private readonly exportPage: Pick<IndexSearchExportPage, 'execute'>,
    private readonly refresh: Pick<RefreshSearchProjection, 'execute'>,
    private readonly promote: Pick<PromoteSearchRebuild, 'execute'>,
    private readonly exports: SearchRebuildExportPort,
  ) {}
  // #endregion

  // #region Methods
  /** Reads state, then performs one step without holding a database transaction over I/O. */
  public async execute(input: RebuildSearchIndexStepInput): Promise<RebuildSearchIndexStepOutput> {
    if (
      !Number.isFinite(input.now.getTime()) ||
      !Number.isFinite(input.claimDeadline.getTime()) ||
      input.claimDeadline <= input.now
    ) {
      throw new Error('Invalid search rebuild step deadline.');
    }
    const state = await this.runtime.readState();
    const building = state.building;
    if (building !== null) {
      const candidate = building.generation;
      if (
        state.buildingHasExpiredIntent ||
        (candidate.engineCreatedAt === null &&
          input.now.getTime() - building.updatedAt.getTime() >= unboundTimeoutMs)
      ) {
        await this.abandon.execute({ generationId: candidate.id });
        return 'abandoned';
      }
      if (candidate.engineCreatedAt === null) return 'waiting';
      const identity = await this.engine.readIdentity(candidate.indexUid, input.signal);
      if (identity === null || identity !== candidate.engineCreatedAt) {
        await this.abandon.execute({ generationId: candidate.id });
        return 'abandoned';
      }
      const active = state.active;
      if (input.serveActive && active?.engineCreatedAt != null && !state.activeQueueStuck) {
        const activeIdentity = await this.engine.readIdentity(active.indexUid, input.signal);
        if (activeIdentity === active.engineCreatedAt) {
          const activeRefresh = await this.refresh.execute({
            generation: {
              id: active.id,
              indexUid: active.indexUid,
              engineCreatedAt: activeIdentity,
            },
            token: input.claimToken,
            deadline: input.claimDeadline,
            signal: input.signal,
          });
          return activeRefresh === 'applied'
            ? 'progressed'
            : activeRefresh === 'requires-cascade'
              ? 'waiting'
              : 'idle';
        }
      }
      const checkpoint = await this.nextCheckpoint.execute({ generationId: candidate.id });
      if (checkpoint !== null) {
        if (checkpoint.deferred || checkpoint.inFlightDeadline !== null) return 'waiting';
        let result: Awaited<ReturnType<IndexSearchExportPage['execute']>>;
        try {
          result = await this.exportPage.execute({
            generation: candidate,
            checkpoint,
            claimToken: input.claimToken,
            claimedAt: input.now,
            claimDeadline: input.claimDeadline,
            signal: input.signal,
          });
        } catch (error: unknown) {
          if (
            checkpoint.cursor !== null &&
            error instanceof SearchAuthorityReadError &&
            error.reason === 'invalid-request'
          ) {
            await this.abandon.execute({ generationId: candidate.id });
            return 'abandoned';
          }
          if (error instanceof SearchAuthorityReadError && error.reason !== 'cancelled') {
            await this.exports.run((transaction) =>
              transaction.deferCheckpoint(candidate.id, checkpoint, nextSearchReadAttempt()),
            );
          }
          throw error;
        }
        if (result === 'expired') {
          await this.abandon.execute({ generationId: candidate.id });
          return 'abandoned';
        }
        return result === 'progressed' ? 'progressed' : 'waiting';
      }
      const refresh = await this.refresh.execute({
        generation: { id: candidate.id, indexUid: candidate.indexUid, engineCreatedAt: identity },
        token: input.claimToken,
        deadline: input.claimDeadline,
        signal: input.signal,
      });
      if (refresh === 'applied') return 'progressed';
      if (refresh === 'requires-cascade' || state.pendingRefreshes) return 'waiting';
      const broker = await this.broker.read(input.signal);
      if (broker === null) return 'waiting';
      try {
        await this.promote.execute({
          generationId: candidate.id,
          engineCreatedAt: identity,
          broker,
        });
      } catch (error: unknown) {
        if (error instanceof SearchRebuildPromotionError && error.reason === 'invalidated') {
          await this.abandon.execute({ generationId: candidate.id });
          return 'abandoned';
        }
        throw error;
      }
      return 'promoted';
    }
    const active = state.active;
    const activeIdentity =
      active?.engineCreatedAt == null
        ? null
        : await this.engine.readIdentity(active.indexUid, input.signal);
    const observedBroker =
      input.checkActiveBroker &&
      active?.engineCreatedAt != null &&
      activeIdentity === active.engineCreatedAt &&
      !state.activeQueueStuck
        ? await this.broker.read(input.signal)
        : null;
    if (
      active?.engineCreatedAt == null ||
      activeIdentity !== active.engineCreatedAt ||
      state.activeQueueStuck ||
      (observedBroker !== null && brokerIdentityChanged(active.brokerAtStart, observedBroker))
    ) {
      const broker = observedBroker ?? (await this.broker.read(input.signal));
      if (broker === null) return 'waiting';
      const registration = await this.register.execute({
        generationId: input.generationId,
        brokerAtStart: broker,
      });
      if (!registration.newlyRegistered) return 'waiting';
      const identity = await this.engine.create(registration.generation.indexUid, input.signal);
      await this.bind.execute({
        generationId: registration.generation.id,
        engineCreatedAt: identity,
      });
      return 'created';
    }
    const refresh = await this.refresh.execute({
      generation: {
        id: active.id,
        indexUid: active.indexUid,
        engineCreatedAt: active.engineCreatedAt,
      },
      token: input.claimToken,
      deadline: input.claimDeadline,
      signal: input.signal,
    });
    return refresh === 'applied'
      ? 'progressed'
      : refresh === 'requires-cascade'
        ? 'waiting'
        : 'idle';
  }
  // #endregion
}

function brokerIdentityChanged(
  baseline: SearchRebuildBrokerProgress,
  current: SearchRebuildBrokerProgress,
): boolean {
  if (baseline.stream !== current.stream || baseline.createdAt !== current.createdAt) return true;
  if (baseline.consumers.length !== current.consumers.length) return true;
  const original = new Map(
    baseline.consumers.map((consumer) => [consumer.handler, consumer.createdAt]),
  );
  if (new Set(current.consumers.map((consumer) => consumer.handler)).size !== original.size)
    return true;
  return current.consumers.some(
    (consumer) => original.get(consumer.handler) !== consumer.createdAt,
  );
}
