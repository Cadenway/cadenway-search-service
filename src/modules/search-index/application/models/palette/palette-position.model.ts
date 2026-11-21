/** A unique key in the contract's task-then-list ordering. */
export interface PalettePosition {
  // #region Properties
  /** Indexed resource kind. */
  readonly kind: 'task' | 'list';

  /** Canonical task key or list UUID. */
  readonly id: string;
  // #endregion
}
