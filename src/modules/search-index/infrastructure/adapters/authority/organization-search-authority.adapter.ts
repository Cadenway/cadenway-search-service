import {
  GetSearchMembershipInternalResponse,
  ListSearchOrganizationsInternalQueryParams,
  ListSearchOrganizationsInternalResponse,
} from '@cadenway/contracts/validators/internal/organization-service';
import type { InternalHttpClient } from '@cadenway/nest-common';

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
import { assertAuthorityPage } from './search-authority-response.js';

const ORGANIZATIONS_PATH = '/internal/v1/search-organizations';
const MEMBERSHIP_PATH = '/internal/v1/search-membership';

/** Reads the organization roster and live membership from the owning service. */
export class OrganizationSearchAuthorityAdapter
  implements
    Pick<SearchSystemAuthority, 'listOrganizations'>,
    Pick<SearchDelegatedAuthority, 'getMembership'>
{
  // #region Constructor
  /** Takes a signed client for the organization-service audience. */
  public constructor(private readonly client: Pick<InternalHttpClient, 'fetch'>) {}
  // #endregion

  // #region Methods
  /** Uses a non-tenant system token to page active organization identifiers. */
  public async listOrganizations(
    query: SearchAuthorityModel['pageRequest'],
    signal?: AbortSignal,
  ): ReturnType<SearchSystemAuthority['listOrganizations']> {
    const params = parseAuthorityInput(ListSearchOrganizationsInternalQueryParams, query);
    const result = await requestAuthorityJson(
      this.client,
      { path: authorityQueryPath(ORGANIZATIONS_PATH, params), claims: searchSystemClaims(null) },
      ListSearchOrganizationsInternalResponse,
      signal,
    );
    const ids = result.items.map((id) => id.toLowerCase());
    assertAuthorityPage(result, params, ids, true);
    return { items: ids, nextCursor: result.nextCursor };
  }

  /** Obtains current delegated-user evidence, or null for confirmed absence. */
  public getMembership(
    organizationId: string,
    userId: string,
    signal?: AbortSignal,
  ): ReturnType<SearchDelegatedAuthority['getMembership']> {
    return requestAuthorityJson(
      this.client,
      {
        path: MEMBERSHIP_PATH,
        claims: searchUserClaims(organizationId, userId),
        allowMissingMembership: true,
      },
      GetSearchMembershipInternalResponse,
      signal,
    );
  }
  // #endregion
}
