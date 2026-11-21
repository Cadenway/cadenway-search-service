import { CONFIG } from '@cadenway/nest-common';
import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import { EventConsumers } from '@cadenway/nest-messaging';
import type { FactoryProvider, OnApplicationBootstrap } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { RecordSearchRefreshes } from '../../../../application/use-cases/commands/rebuild/record-search-refreshes/record-search-refreshes.use-case.js';
import { DrizzleSearchRefreshUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-refresh.unit-of-work.js';
import { subscribeSearchSourceEvents } from '../../../../presentation/messaging/handlers/rebuild/search-source-events.handler.js';

/** Registers the configured source consumers during service startup. */
class SearchSourceSubscriptions implements OnApplicationBootstrap {
  // #region Constructor
  /** Receives the dependencies for subscribing once the service is configured. */
  public constructor(
    private readonly enabled: boolean,
    private readonly consumers: EventConsumers,
    private readonly record: RecordSearchRefreshes,
  ) {}
  // #endregion

  // #region Methods
  /** Registers the exact subscriptions before the search worker may observe broker progress. */
  public async onApplicationBootstrap(): Promise<void> {
    if (this.enabled) await subscribeSearchSourceEvents(this.consumers, this.record);
  }
  // #endregion
}

/** Enables durable invalidation recording when the engine and owner connections are configured. */
export const searchSourceSubscriptionsProvider: FactoryProvider<SearchSourceSubscriptions> = {
  provide: SearchSourceSubscriptions,
  inject: [CONFIG, EventConsumers, SystemTransactionRunner],
  useFactory: (
    config: AppConfig,
    consumers: EventConsumers,
    system: SystemTransactionRunner<DatabaseSchema>,
  ): SearchSourceSubscriptions =>
    new SearchSourceSubscriptions(
      config.MEILI_URL !== undefined && config.INTERNAL_TOKEN_PRIVATE_JWK !== undefined,
      consumers,
      new RecordSearchRefreshes(new DrizzleSearchRefreshUnitOfWork(system)),
    ),
};
