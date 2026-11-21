/** Source-owned search data after validation by an authority adapter. */
export interface SearchAuthorityModel {
  // #region Properties
  /** Task-owned resource kind. */
  readonly kind: 'task' | 'list' | 'space';

  /** A page request for a source scan. */
  readonly pageRequest: { readonly cursor?: string; readonly limit?: number };

  /** A task-owned page request, optionally restricted to a parent. */
  readonly taskPageRequest: {
    readonly kind: 'task' | 'list' | 'space';
    readonly cursor?: string;
    readonly limit?: number;
    readonly spaceId?: string;
    readonly listId?: string;
  };

  /** Active task, list, or space metadata. */
  readonly taskProjection:
    | {
        readonly kind: 'task';
        readonly id: string;
        readonly version: number;
        readonly name: string;
        readonly lifecycle: 'active';
        readonly status: string;
        readonly listId: string;
        readonly spaceId: string;
      }
    | {
        readonly kind: 'list';
        readonly id: string;
        readonly version: number;
        readonly name: string;
        readonly lifecycle: 'active';
        readonly spaceId: string;
      }
    | {
        readonly kind: 'space';
        readonly id: string;
        readonly version: number;
        readonly name: string;
        readonly lifecycle: 'active';
      };

  /** Active document metadata and text. */
  readonly documentProjection: {
    readonly documentId: string;
    readonly spaceId: string;
    readonly version: number;
    readonly title: string;
    readonly body: string;
  };

  /** Active attachment metadata. */
  readonly attachmentProjection: {
    readonly fileId: string;
    readonly taskKey: string;
    readonly fileName: string;
    readonly version: number;
  };
  // #endregion
}
