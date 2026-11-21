import type { SearchAuthorityModel } from '../../../../models/authority/search-authority.model.js';

/** Current access evidence obtained on behalf of an authenticated user. */
export interface SearchDelegatedAuthority {
  // #region Methods
  /**
   * Returns null only when Organization confirms that the active membership is absent.
   * Transport failures, invalid responses and authorization failures reject the call.
   */
  getMembership(
    organizationId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly memberId: string;
    readonly role: 'owner' | 'admin' | 'member' | 'guest';
    readonly version: number;
  } | null>;

  /** Resolves the requested candidates against the current membership and access rules. */
  resolveAccess(
    organizationId: string,
    userId: string,
    lookup: {
      readonly membership: {
        readonly memberId: string;
        readonly role: 'owner' | 'admin' | 'member' | 'guest';
        readonly version: number;
      };
      readonly candidates: readonly {
        readonly kind: SearchAuthorityModel['kind'];
        readonly id: string;
      }[];
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly results: readonly (
      | {
          readonly kind: 'task';
          readonly id: string;
          readonly version: number;
          readonly listId: string;
          readonly spaceId: string;
        }
      | {
          readonly kind: 'list';
          readonly id: string;
          readonly version: number;
          readonly spaceId: string;
        }
      | {
          readonly kind: 'space';
          readonly id: string;
          readonly version: number;
          readonly directSpace: boolean;
        }
    )[];
  }>;
  // #endregion
}
