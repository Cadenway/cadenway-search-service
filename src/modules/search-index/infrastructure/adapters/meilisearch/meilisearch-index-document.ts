import type { StatusKey } from '@cadenway/contracts';

import type { MeilisearchProjectionKey } from './meilisearch-projection-key.js';

/** Derived lookup metadata and searchable text stored in a generation index. */
export interface MeilisearchIndexDocument extends MeilisearchProjectionKey {
  // #region Properties
  /** Organization that owns the source resource. */
  readonly organizationId: string;

  /** Version reported by the source. */
  readonly version: number;

  /** Searchable label from the source. */
  readonly title: string;

  /** Current published status key, required for tasks and absent for other kinds. */
  readonly status?: StatusKey;

  /** Searchable text excluded from displayed attributes. */
  readonly text?: string;

  /** Current list placement, when applicable. */
  readonly listId?: string;

  /** Current space placement, when applicable. */
  readonly spaceId?: string;

  /** Owning task key for an attachment. */
  readonly taskKey?: string;
  // #endregion
}
