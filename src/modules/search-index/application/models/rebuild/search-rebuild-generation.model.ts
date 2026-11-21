import type { SearchRebuildBrokerProgress } from '../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';

/** Identity and durable lifecycle state of a physical search index. */
export interface SearchRebuildGeneration {
  // #region Properties
  /** Identifier of the generation in Search's database. */
  readonly id: string;

  /** Unique name of the physical Meilisearch index. */
  readonly indexUid: string;

  /** Creation timestamp recorded when the physical index was prepared. */
  readonly engineCreatedAt: string | null;

  /** Lifecycle observed inside the rebuild transaction. */
  readonly status: 'building' | 'active' | 'abandoned' | 'retired';

  /** Stream and durable identities observed before any authoritative scan began. */
  readonly brokerAtStart: SearchRebuildBrokerProgress;
  // #endregion
}
