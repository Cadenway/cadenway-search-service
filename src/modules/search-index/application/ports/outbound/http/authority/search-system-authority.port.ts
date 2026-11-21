import type { SearchAuthorityModel } from '../../../../models/authority/search-authority.model.js';

/** Current authoritative projections requested by the Search system actor. */
export interface SearchSystemAuthority {
  // #region Methods
  /** Lists active organizations with a cursor bounded by the initial snapshot. */
  listOrganizations(
    query: SearchAuthorityModel['pageRequest'],
    signal?: AbortSignal,
  ): Promise<{ readonly items: readonly string[]; readonly nextCursor: string | null }>;

  /** Lists task, list or space projections within the organization. */
  listTaskProjections(
    organizationId: string,
    query: SearchAuthorityModel['taskPageRequest'],
    signal?: AbortSignal,
  ): Promise<{
    readonly items: readonly SearchAuthorityModel['taskProjection'][];
    readonly nextCursor: string | null;
  }>;

  /** Resolves each requested task, list or space in input order. */
  resolveTaskProjections(
    organizationId: string,
    lookup: { readonly kind: SearchAuthorityModel['kind']; readonly ids: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{
    readonly results: readonly (
      | { readonly status: 'present'; readonly projection: SearchAuthorityModel['taskProjection'] }
      | { readonly status: 'absent'; readonly id: string; readonly version: number | null }
    )[];
  }>;

  /** Lists current document projections within the organization. */
  listDocuments(
    organizationId: string,
    query: SearchAuthorityModel['pageRequest'],
    signal?: AbortSignal,
  ): Promise<{
    readonly items: readonly SearchAuthorityModel['documentProjection'][];
    readonly nextCursor: string | null;
  }>;

  /** Resolves each requested document in input order. */
  resolveDocuments(
    organizationId: string,
    lookup: { readonly documentIds: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{
    readonly results: readonly (
      | {
          readonly status: 'present';
          readonly projection: SearchAuthorityModel['documentProjection'];
        }
      | { readonly status: 'absent'; readonly documentId: string; readonly version: number | null }
    )[];
  }>;

  /** Lists current attachment projections within the organization. */
  listAttachments(
    organizationId: string,
    query: SearchAuthorityModel['pageRequest'],
    signal?: AbortSignal,
  ): Promise<{
    readonly items: readonly SearchAuthorityModel['attachmentProjection'][];
    readonly nextCursor: string | null;
  }>;

  /** Resolves each requested attachment in input order. */
  resolveAttachments(
    organizationId: string,
    lookup: { readonly fileIds: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{
    readonly results: readonly (
      | {
          readonly status: 'present';
          readonly projection: SearchAuthorityModel['attachmentProjection'];
        }
      | { readonly status: 'absent'; readonly fileId: string; readonly version: number | null }
    )[];
  }>;
  // #endregion
}
