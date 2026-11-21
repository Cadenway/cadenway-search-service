import type { HealthIndicator } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { searchAuthoritiesProvider } from './composition/providers/adapters/authority/search-authorities.provider.js';
import { searchIndexEngineProvider } from './composition/providers/adapters/rebuild/search-index-engine.provider.js';
import { searchRebuildLoopProvider } from './composition/providers/adapters/rebuild/search-rebuild-loop.provider.js';
import { searchSourceSubscriptionsProvider } from './composition/providers/adapters/rebuild/search-source-subscriptions.provider.js';
import { searchPaletteProvider } from './composition/providers/use-cases/palette/search-palette.provider.js';
import { MeilisearchIndexAdapter } from './infrastructure/adapters/meilisearch/meilisearch-index.adapter.js';
import { SearchPaletteController } from './presentation/http/controllers/palette/search-palette.controller.js';

/** Composes the source clients and durable subscriptions of the search index. */
@Module({
  controllers: [SearchPaletteController],
  providers: [
    searchAuthoritiesProvider,
    searchIndexEngineProvider,
    searchSourceSubscriptionsProvider,
    searchPaletteProvider,
    searchRebuildLoopProvider,
  ],
})
export class SearchIndexModule {
  // #region Methods
  /** Builds the health indicator for the service bootstrap. */
  public static readiness(config: AppConfig): HealthIndicator | null {
    if (config.MEILI_URL === undefined || config.MEILI_API_KEY === undefined) return null;
    const engine = new MeilisearchIndexAdapter({
      baseUrl: config.MEILI_URL,
      apiKey: config.MEILI_API_KEY,
      timeoutMs: 750,
    });
    return { name: 'meilisearch', check: () => engine.checkHealth() };
  }
  // #endregion
}
