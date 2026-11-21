import {
  ListAttachmentSearchProjectionsInternalQueryParams,
  ListAttachmentSearchProjectionsInternalResponse,
  ResolveAttachmentSearchProjectionsInternalBody,
  ResolveAttachmentSearchProjectionsInternalResponse,
} from '@cadenway/contracts/validators/internal/storage-service';
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

const PROJECTIONS_PATH = '/internal/v1/attachment-search-projections';

/** Reads ready attachment projections and authoritative absences for one tenant. */
export class StorageSearchAuthorityAdapter implements Pick<
  SearchSystemAuthority,
  'listAttachments' | 'resolveAttachments'
> {
  // #region Constructor
  /** Takes a signed client for the storage-service audience. */
  public constructor(private readonly client: Pick<InternalHttpClient, 'fetch'>) {}
  // #endregion

  // #region Methods
  /** Pages attachment metadata with the signed Search system tenant. */
  public async listAttachments(
    organizationId: string,
    query: SearchAuthorityModel['pageRequest'],
    signal?: AbortSignal,
  ): ReturnType<SearchSystemAuthority['listAttachments']> {
    const params = parseAuthorityInput(ListAttachmentSearchProjectionsInternalQueryParams, query);
    const result = await requestAuthorityJson(
      this.client,
      {
        path: authorityQueryPath(PROJECTIONS_PATH, params),
        claims: searchSystemClaims(organizationId),
      },
      ListAttachmentSearchProjectionsInternalResponse,
      signal,
    );
    assertAuthorityPage(
      result,
      params,
      result.items.map(({ fileId }) => fileId.toLowerCase()),
      true,
    );
    return result;
  }

  /** Resolves every requested attachment in order, including known terminal versions. */
  public async resolveAttachments(
    organizationId: string,
    lookup: { readonly fileIds: readonly string[] },
    signal?: AbortSignal,
  ): ReturnType<SearchSystemAuthority['resolveAttachments']> {
    const input = parseAuthorityInput(ResolveAttachmentSearchProjectionsInternalBody, lookup);
    const ids = input.fileIds.map((id) => id.toLowerCase());
    assertUniqueAuthorityIds(ids);
    const result = await requestAuthorityJson(
      this.client,
      {
        path: `${PROJECTIONS_PATH}/resolve`,
        claims: searchSystemClaims(organizationId),
        body: input,
      },
      ResolveAttachmentSearchProjectionsInternalResponse,
      signal,
    );
    const resolved = result.results.map((item) =>
      (item.status === 'present' ? item.projection.fileId : item.fileId).toLowerCase(),
    );
    assertOrderedAuthorityDecisions(ids, resolved);
    return result;
  }
  // #endregion
}
