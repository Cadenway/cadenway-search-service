import type { HealthIndicator } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { MeilisearchIndexAdapter } from './infrastructure/adapters/meilisearch/meilisearch-index.adapter.js';

/** Registers the readiness probe when the search engine is configured. */
@Module({})
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
