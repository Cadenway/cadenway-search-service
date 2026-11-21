import { CONFIG } from '@cadenway/nest-common';
import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { MeilisearchIndexAdapter } from '../../../../infrastructure/adapters/meilisearch/meilisearch-index.adapter.js';
import { DrizzleSearchRuntimeStateRepository } from '../../../../infrastructure/persistence/drizzle/repositories/rebuild/drizzle-search-runtime-state.repository.js';
import { SEARCH_INDEX_ENGINE } from '../../../tokens/rebuild/search-index-engine.token.js';

/** Composes the Meilisearch adapter and the live PostgreSQL index pointer. */
export const searchIndexEngineProvider: FactoryProvider<MeilisearchIndexAdapter | null> = {
  provide: SEARCH_INDEX_ENGINE,
  inject: [CONFIG, SystemTransactionRunner],
  useFactory: (
    config: AppConfig,
    system: SystemTransactionRunner<DatabaseSchema>,
  ): MeilisearchIndexAdapter | null => {
    if (config.MEILI_URL === undefined || config.MEILI_API_KEY === undefined) return null;
    const runtime = new DrizzleSearchRuntimeStateRepository(system);
    return new MeilisearchIndexAdapter({
      baseUrl: config.MEILI_URL,
      apiKey: config.MEILI_API_KEY,
      timeoutMs: 15_000,
      findActiveGeneration: async (signal) =>
        (await runtime.findGeneration('active', signal))?.generation ?? null,
    });
  },
};
