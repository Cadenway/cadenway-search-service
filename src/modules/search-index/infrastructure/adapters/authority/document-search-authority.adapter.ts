import {
  ListDocumentSearchProjectionsInternalQueryParams,
  ListDocumentSearchProjectionsInternalResponse,
  ResolveDocumentSearchProjectionsInternalBody,
  ResolveDocumentSearchProjectionsInternalResponse,
} from '@cadenway/contracts/validators/internal/document-service';
import type { InternalHttpClient } from '@cadenway/nest-common';

import type { SearchAuthorityModel } from '../../../application/models/authority/search-authority.model.js';
import type { SearchSystemAuthority } from '../../../application/ports/outbound/http/authority/search-system-authority.port.js';
import {
  authorityQueryPath,
  parseAuthorityInput,
  requestAuthorityJson,
  searchSystemClaims,
} from './search-authority-http.js';
import {
  assertAuthorityPage,
  assertOrderedAuthorityDecisions,
  assertUniqueAuthorityIds,
} from './search-authority-response.js';

const PROJECTIONS_PATH = '/internal/v1/document-search-projections';

/** Reads uncached Document projections using the Search system identity for one tenant. */
export class DocumentSearchAuthorityAdapter implements Pick<
  SearchSystemAuthority,
  'listDocuments' | 'resolveDocuments'
> {
  // #region Constructor
  /** Takes a signed client for the document-service audience. */
  public constructor(private readonly client: Pick<InternalHttpClient, 'fetch'>) {}
  // #endregion

  // #region Methods
  /** Pages active Document projections in source UUID order. */
  public async listDocuments(
    organizationId: string,
    query: SearchAuthorityModel['pageRequest'],
    signal?: AbortSignal,
  ): ReturnType<SearchSystemAuthority['listDocuments']> {
    const params = parseAuthorityInput(ListDocumentSearchProjectionsInternalQueryParams, query);
    const result = await requestAuthorityJson(
      this.client,
      {
        path: authorityQueryPath(PROJECTIONS_PATH, params),
        claims: searchSystemClaims(organizationId),
      },
      ListDocumentSearchProjectionsInternalResponse,
      signal,
    );
    assertAuthorityPage(
      result,
      params,
      result.items.map(({ documentId }) => documentId.toLowerCase()),
      true,
    );
    return result;
  }

  /** Resolves a full ordered batch or rejects it so the worker can preserve pending work. */
  public async resolveDocuments(
    organizationId: string,
    lookup: { readonly documentIds: readonly string[] },
    signal?: AbortSignal,
  ): ReturnType<SearchSystemAuthority['resolveDocuments']> {
    const input = parseAuthorityInput(ResolveDocumentSearchProjectionsInternalBody, lookup);
    const ids = input.documentIds.map((id) => id.toLowerCase());
    assertUniqueAuthorityIds(ids);
    const result = await requestAuthorityJson(
      this.client,
      {
        path: `${PROJECTIONS_PATH}/resolve`,
        claims: searchSystemClaims(organizationId),
        body: input,
        batchLimitCode: 'document.projection-batch-too-large',
      },
      ResolveDocumentSearchProjectionsInternalResponse,
      signal,
    );
    const resolved = result.results.map((item) =>
      (item.status === 'present' ? item.projection.documentId : item.documentId).toLowerCase(),
    );
    assertOrderedAuthorityDecisions(ids, resolved);
    return result;
  }
  // #endregion
}
