/** An inactive index whose recorded generation identity can authorize physical deletion. */
export interface SearchPrunableGeneration {
  // #region Properties
  /** Database ID, physical UID and creation time verified when the generation was bound. */
  readonly id: string;
  readonly indexUid: string;
  readonly engineCreatedAt: string;
  // #endregion
}
