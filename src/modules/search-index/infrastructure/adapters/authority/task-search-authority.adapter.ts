import {
  ListTaskSearchProjectionsInternalQueryParams,
  ListTaskSearchProjectionsInternalResponse,
  ResolveTaskSearchAccessInternalBody,
  ResolveTaskSearchAccessInternalResponse,
  ResolveTaskSearchProjectionsInternalBody,
  ResolveTaskSearchProjectionsInternalResponse,
} from '@cadenway/contracts/validators/internal/task-service';
import type { InternalHttpClient } from '@cadenway/nest-common';

import { SearchAuthorityReadError } from '../../../domain/errors/authority/search-authority-read.error.js';
import type { SearchAuthorityModel } from '../../../application/models/authority/search-authority.model.js';
import type { SearchDelegatedAuthority } from '../../../application/ports/outbound/http/authority/search-delegated-authority.port.js';
import type { SearchSystemAuthority } from '../../../application/ports/outbound/http/authority/search-system-authority.port.js';
import {
  authorityQueryPath,
  parseAuthorityInput,
  requestAuthorityJson,
  searchSystemClaims,
  searchUserClaims,
} from './search-authority-http.js';
import {
  assertAuthorityPage,
  assertAuthorityProof,
  assertOrderedAuthorityDecisions,
  assertUniqueAuthorityIds,
  taskAuthorityId,
  taskAuthoritySelector,
} from './search-authority-response.js';

const PROJECTIONS_PATH = '/internal/v1/task-search-projections';
const ACCESS_PATH = '/internal/v1/task-search-access/resolve';

/** Reads current Task projections and delegated-user access proofs for one tenant. */
export class TaskSearchAuthorityAdapter
  implements
    Pick<SearchSystemAuthority, 'listTaskProjections' | 'resolveTaskProjections'>,
    Pick<SearchDelegatedAuthority, 'resolveAccess'>
{
  // #region Constructor
  /** Takes a signed client for the task-service audience. */
  public constructor(private readonly client: Pick<InternalHttpClient, 'fetch'>) {}
  // #endregion

  // #region Methods
  /** Reads one page of a single resource kind and verifies its requested placement. */
  public async listTaskProjections(
    organizationId: string,
    query: SearchAuthorityModel['taskPageRequest'],
    signal?: AbortSignal,
  ): ReturnType<SearchSystemAuthority['listTaskProjections']> {
    const params = parseAuthorityInput(ListTaskSearchProjectionsInternalQueryParams, query);
    if (
      (params.spaceId !== undefined && params.kind === 'space') ||
      (params.listId !== undefined && params.kind !== 'task')
    ) {
      throw new SearchAuthorityReadError('invalid-request');
    }

    const result = await requestAuthorityJson(
      this.client,
      {
        path: authorityQueryPath(PROJECTIONS_PATH, params),
        claims: searchSystemClaims(organizationId),
      },
      ListTaskSearchProjectionsInternalResponse,
      signal,
    );
    if (result.items.some((item) => !isProjectionForQuery(item, query))) {
      throw new SearchAuthorityReadError('unavailable');
    }

    // Task pages are ordered by an internal UUID. The wire only includes the stable Task key.
    const ids = result.items.map((item) => item.id);
    assertAuthorityPage(result, params, ids, params.kind !== 'task');
    return result;
  }

  /** Accepts only a complete decision for each requested identifier of the selected kind. */
  public async resolveTaskProjections(
    organizationId: string,
    lookup: { readonly kind: SearchAuthorityModel['kind']; readonly ids: readonly string[] },
    signal?: AbortSignal,
  ): ReturnType<SearchSystemAuthority['resolveTaskProjections']> {
    const input = parseAuthorityInput(ResolveTaskSearchProjectionsInternalBody, lookup);
    const ids = input.ids.map((id) => taskAuthorityId(input.kind, id));
    assertUniqueAuthorityIds(ids);
    const result = await requestAuthorityJson(
      this.client,
      {
        path: `${PROJECTIONS_PATH}/resolve`,
        claims: searchSystemClaims(organizationId),
        body: input,
        batchLimitCode: 'task.projection-batch-too-large',
      },
      ResolveTaskSearchProjectionsInternalResponse,
      signal,
    );
    if (
      result.results.some(
        (item) => item.status === 'present' && item.projection.kind !== input.kind,
      )
    ) {
      throw new SearchAuthorityReadError('unavailable');
    }
    const resolved = result.results.map((item) =>
      item.status === 'present' ? item.projection.id : item.id,
    );
    assertOrderedAuthorityDecisions(ids, resolved);
    return result;
  }

  /** Reads only an ordered subset of the candidates signed on behalf of the calling user. */
  public async resolveAccess(
    organizationId: string,
    userId: string,
    lookup: Parameters<SearchDelegatedAuthority['resolveAccess']>[2],
    signal?: AbortSignal,
  ): ReturnType<SearchDelegatedAuthority['resolveAccess']> {
    const input = parseAuthorityInput(ResolveTaskSearchAccessInternalBody, lookup);
    const candidates = input.candidates.map(taskAuthoritySelector);
    assertUniqueAuthorityIds(candidates);
    const result = await requestAuthorityJson(
      this.client,
      { path: ACCESS_PATH, claims: searchUserClaims(organizationId, userId), body: input },
      ResolveTaskSearchAccessInternalResponse,
      signal,
    );
    if (result.results.some((item) => item.id !== taskAuthorityId(item.kind, item.id))) {
      throw new SearchAuthorityReadError('unavailable');
    }
    assertAuthorityProof(candidates, result.results.map(taskAuthoritySelector));
    return result;
  }
  // #endregion
}

function isProjectionForQuery(
  item: SearchAuthorityModel['taskProjection'],
  query: SearchAuthorityModel['taskPageRequest'],
): boolean {
  return (
    item.kind === query.kind &&
    item.id === taskAuthorityId(item.kind, item.id) &&
    (query.spaceId === undefined ||
      (item.kind !== 'space' && item.spaceId.toLowerCase() === query.spaceId.toLowerCase())) &&
    (query.listId === undefined ||
      (item.kind === 'task' && item.listId.toLowerCase() === query.listId.toLowerCase()))
  );
}
