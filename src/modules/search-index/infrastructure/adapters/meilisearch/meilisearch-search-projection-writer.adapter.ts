import { STATUS_KEYS } from '@cadenway/contracts';
import { z } from 'zod';

import type { SearchProjectionIndexerPort } from '../../../application/ports/outbound/search/rebuild/search-projection-indexer.port.js';
import type { SearchProjectionRemoverPort } from '../../../application/ports/outbound/search/rebuild/search-projection-remover.port.js';

import type { MeilisearchIndexAdapter } from './meilisearch-index.adapter.js';
import type { MeilisearchIndexDocument } from './meilisearch-index-document.js';
import { MeilisearchIndexError } from './meilisearch-index.error.js';

const statusKey = z.enum(STATUS_KEYS);

type WriteArgs = Parameters<SearchProjectionIndexerPort['write']>;
type RemoveArgs = Parameters<SearchProjectionRemoverPort['remove']>;

/** Writes or removes current source projections in a verified physical generation. */
export class MeilisearchSearchProjectionWriterAdapter
  implements SearchProjectionIndexerPort, SearchProjectionRemoverPort
{
  // #region Constructor
  /** Reuses the adapter that tracks physical Meilisearch tasks. */
  public constructor(private readonly engine: MeilisearchIndexAdapter) {}
  // #endregion

  // #region Methods
  /** Translates source records and waits until all physical replacements succeed. */
  public async write(
    ...[generation, organizationId, source, projections, signal]: WriteArgs
  ): Promise<void> {
    const kind = source === 'storage' ? 'attachment' : source;
    const documents = projections.map((projection) => {
      const document = toDocument(organizationId, projection);
      if (document.kind !== kind) throw new MeilisearchIndexError('invalid-request');
      return document;
    });
    await this.engine.upsertDocuments(
      generation.indexUid,
      generation.engineCreatedAt,
      organizationId,
      documents,
      signal,
    );
  }

  /** Removes the exact source identity from the expected physical generation. */
  public async remove(...[generation, target, signal]: RemoveArgs): Promise<void> {
    await this.engine.deleteDocuments(
      generation.indexUid,
      generation.engineCreatedAt,
      target.organizationId,
      [{ kind: target.kind === 'storage' ? 'attachment' : target.kind, sourceId: target.sourceId }],
      signal,
    );
  }
  // #endregion
}

function toDocument(
  organizationId: string,
  source: WriteArgs[3][number],
): MeilisearchIndexDocument {
  if ('documentId' in source) {
    return {
      organizationId,
      kind: 'document',
      sourceId: source.documentId,
      version: source.version,
      title: source.title,
      text: source.body,
      spaceId: source.spaceId,
    };
  }
  if ('fileId' in source) {
    return {
      organizationId,
      kind: 'attachment',
      sourceId: source.fileId,
      version: source.version,
      title: source.fileName,
      taskKey: source.taskKey,
    };
  }

  const common = {
    organizationId,
    kind: source.kind,
    sourceId: source.id,
    version: source.version,
    title: source.name,
  };
  if (source.kind === 'space') return common;
  if (source.kind === 'list') return { ...common, spaceId: source.spaceId };

  const status = statusKey.safeParse(source.status);
  if (!status.success) throw new MeilisearchIndexError('invalid-request');
  return { ...common, spaceId: source.spaceId, listId: source.listId, status: status.data };
}
