import { randomUUID } from 'node:crypto';

import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import { EventConsumers, MessagingConnection } from '@cadenway/nest-messaging';
import type {
  BeforeApplicationShutdown,
  FactoryProvider,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';

import { AbandonSearchGeneration } from '../../../../application/use-cases/commands/rebuild/abandon-search-generation/abandon-search-generation.use-case.js';
import { BindSearchGeneration } from '../../../../application/use-cases/commands/rebuild/bind-search-generation/bind-search-generation.use-case.js';
import { ClaimSearchExportPage } from '../../../../application/use-cases/commands/rebuild/claim-search-export-page/claim-search-export-page.use-case.js';
import { IndexSearchExportPage } from '../../../../application/use-cases/commands/rebuild/index-search-export-page/index-search-export-page.use-case.js';
import { PromoteSearchRebuild } from '../../../../application/use-cases/commands/rebuild/promote-search-rebuild/promote-search-rebuild.use-case.js';
import { RebuildSearchIndexStep } from '../../../../application/use-cases/commands/rebuild/rebuild-search-index-step/rebuild-search-index-step.use-case.js';
import { ReconcileSearchParentPage } from '../../../../application/use-cases/commands/rebuild/reconcile-search-parent-page/reconcile-search-parent-page.use-case.js';
import { RecordSearchExportPage } from '../../../../application/use-cases/commands/rebuild/record-search-export-page/record-search-export-page.use-case.js';
import { RecordSearchRosterPage } from '../../../../application/use-cases/commands/rebuild/record-search-roster-page/record-search-roster-page.use-case.js';
import { RefreshSearchProjection } from '../../../../application/use-cases/commands/rebuild/refresh-search-projection/refresh-search-projection.use-case.js';
import { RegisterSearchGeneration } from '../../../../application/use-cases/commands/rebuild/register-search-generation/register-search-generation.use-case.js';
import { NextSearchGenerationCheckpoint } from '../../../../application/use-cases/queries/rebuild/next-search-generation-checkpoint/next-search-generation-checkpoint.use-case.js';
import { JetStreamSearchBrokerProgressAdapter } from '../../../../infrastructure/adapters/jetstream/jetstream-search-broker-progress.adapter.js';
import type { MeilisearchIndexAdapter } from '../../../../infrastructure/adapters/meilisearch/meilisearch-index.adapter.js';
import { MeilisearchIndexError } from '../../../../infrastructure/adapters/meilisearch/meilisearch-index.error.js';
import { MeilisearchSearchProjectionWriterAdapter } from '../../../../infrastructure/adapters/meilisearch/meilisearch-search-projection-writer.adapter.js';
import { DrizzleSearchRuntimeStateRepository } from '../../../../infrastructure/persistence/drizzle/repositories/rebuild/drizzle-search-runtime-state.repository.js';
import { DrizzleSearchGenerationUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-generation.unit-of-work.js';
import { DrizzleSearchParentReconciliation } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-parent-reconciliation.unit-of-work.js';
import { DrizzleSearchRebuildExportUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-rebuild-export.unit-of-work.js';
import { DrizzleSearchRebuildPromotionUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-rebuild-promotion.unit-of-work.js';
import { DrizzleSearchRefreshUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-refresh.unit-of-work.js';
import { searchSourceHandlerNames } from '../../../../presentation/messaging/handlers/rebuild/search-source-events.handler.js';
import { SEARCH_AUTHORITIES } from '../../../tokens/authority/search-authorities.token.js';
import { SEARCH_INDEX_ENGINE } from '../../../tokens/rebuild/search-index-engine.token.js';
import type { SearchAuthorities } from '../authority/search-authorities.provider.js';

/** Schedules one bounded indexing step at a time and cancels it on shutdown. */
class SearchRebuildLoop implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /** Cancellation shared by all operations of this replica. */
  private readonly shutdown = new AbortController();

  /** Structured worker log without upstream response bodies or resource text. */
  private readonly logger = new Logger(SearchRebuildLoop.name);

  /** Selects the next turn of the live index when a candidate is also building. */
  private serveActive = false;

  /** Earliest time another receipt cleanup batch may run. */
  private nextReceiptSweepAt = 0;

  /** Earliest time to sample the broker identities of the active generation again. */
  private nextActiveBrokerCheckAt = 0;

  /** Next indexing step, if scheduled. */
  private timer?: ReturnType<typeof setTimeout>;

  /** Pending bounded work to await before shutdown. */
  private inFlight?: Promise<void>;
  // #endregion

  // #region Constructor
  /** Receives the coordinator when all source and engine connections are configured. */
  public constructor(
    private readonly step: RebuildSearchIndexStep | null,
    private readonly maintenance?: Pick<DrizzleSearchRuntimeStateRepository, 'pruneReceipts'>,
  ) {}
  // #endregion

  // #region Methods
  /** Starts after the application has initialized its subscriptions. */
  public onApplicationBootstrap(): void {
    if (this.step !== null) this.schedule(this.step, 100);
  }

  /** Stops new work and cancels external calls of the current step. */
  public async beforeApplicationShutdown(): Promise<void> {
    this.shutdown.abort();
    clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(step: RebuildSearchIndexStep, delay: number): void {
    if (this.shutdown.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.run(step);
    }, delay);
    this.timer.unref();
  }

  private async run(step: RebuildSearchIndexStep): Promise<void> {
    let delay = 1_000;
    try {
      const now = new Date();
      if (this.maintenance && now.getTime() >= this.nextReceiptSweepAt) {
        this.nextReceiptSweepAt = now.getTime() + 3_600_000;
        if ((await this.maintenance.pruneReceipts()) === 1_000) {
          this.nextReceiptSweepAt = now.getTime() + 1_000;
        }
      }
      this.serveActive = !this.serveActive;
      const checkActiveBroker = now.getTime() >= this.nextActiveBrokerCheckAt;
      if (checkActiveBroker) this.nextActiveBrokerCheckAt = now.getTime() + 30_000;
      const result = await step.execute({
        generationId: randomUUID(),
        claimToken: randomUUID(),
        now,
        claimDeadline: new Date(now.getTime() + 30_000),
        serveActive: this.serveActive,
        checkActiveBroker,
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20_000)]),
      });
      if (result === 'created' || result === 'progressed' || result === 'promoted') delay = 25;
    } catch (error: unknown) {
      if (!this.shutdown.signal.aborted) {
        this.logger.warn({
          msg: 'Search indexing step failed',
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    } finally {
      this.schedule(step, delay);
    }
  }
  // #endregion
}

/** Composes the durable rebuild operations behind a single application lifecycle provider. */
export const searchRebuildLoopProvider: FactoryProvider<SearchRebuildLoop> = {
  provide: SearchRebuildLoop,
  inject: [
    SEARCH_INDEX_ENGINE,
    SEARCH_AUTHORITIES,
    SystemTransactionRunner,
    MessagingConnection,
    EventConsumers,
  ],
  useFactory: (
    engine: MeilisearchIndexAdapter | null,
    authorities: SearchAuthorities | null,
    system: SystemTransactionRunner<DatabaseSchema>,
    connection: MessagingConnection,
    consumers: EventConsumers,
  ): SearchRebuildLoop => {
    if (engine === null || authorities === null) return new SearchRebuildLoop(null);
    const runtime = new DrizzleSearchRuntimeStateRepository(system);
    const generation = new DrizzleSearchGenerationUnitOfWork(system);
    const exports = new DrizzleSearchRebuildExportUnitOfWork(system);
    const refresh = new DrizzleSearchRefreshUnitOfWork(system);
    const promotion = new DrizzleSearchRebuildPromotionUnitOfWork(system);
    const writer = new MeilisearchSearchProjectionWriterAdapter(engine);
    const refreshResource = new RefreshSearchProjection(
      refresh,
      authorities.system,
      writer,
      writer,
    );
    const parentStore = new DrizzleSearchParentReconciliation(system);
    const reconcileParent = new ReconcileSearchParentPage(
      authorities.system,
      { read: engine.readDescendants.bind(engine) },
      parentStore,
      writer,
      writer,
    );
    const broker = new JetStreamSearchBrokerProgressAdapter(
      connection,
      consumers,
      searchSourceHandlerNames,
    );
    return new SearchRebuildLoop(
      new RebuildSearchIndexStep(
        runtime,
        {
          create: engine.createGeneration.bind(engine),
          readIdentity: async (indexUid, signal) => {
            try {
              return await engine.readGenerationIdentity(indexUid, signal);
            } catch (error: unknown) {
              if (error instanceof MeilisearchIndexError && error.code === 'index-not-found')
                return null;
              throw error;
            }
          },
        },
        broker,
        new RegisterSearchGeneration(generation),
        new BindSearchGeneration(generation),
        new AbandonSearchGeneration(generation),
        new NextSearchGenerationCheckpoint(generation),
        new IndexSearchExportPage(
          authorities.system,
          writer,
          new ClaimSearchExportPage(exports),
          new RecordSearchRosterPage(exports),
          new RecordSearchExportPage(exports),
        ),
        {
          execute: async (input) => {
            const result = await refreshResource.execute(input);
            if (result !== 'requires-cascade') return result;
            const parent = await parentStore.claimNextParent(
              input.generation.id,
              input.token,
              input.deadline,
            );
            if (parent === null) return 'requires-cascade';
            const progress = await reconcileParent.execute({
              generation: input.generation,
              ...parent,
              signal: input.signal,
            });
            return progress === 'stale' ? 'requires-cascade' : 'applied';
          },
        },
        new PromoteSearchRebuild(promotion),
      ),
      runtime,
    );
  },
};
