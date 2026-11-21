/** Palette results or a transport-independent failure for the HTTP mapper. */
export type SearchPaletteOutput =
  | {
      readonly kind: 'ok';
      readonly items: readonly (
        | {
            readonly kind: 'task';
            readonly taskKey: string;
            readonly name: string;
            readonly status: string;
          }
        | { readonly kind: 'list'; readonly listId: string; readonly name: string }
      )[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'invalid' | 'not-found' | 'unavailable' };
