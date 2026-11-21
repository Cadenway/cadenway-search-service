/** Indexed metadata awaiting current authorization from the owning services. */
export type PaletteCandidate =
  | {
      readonly kind: 'task';
      readonly id: string;
      readonly name: string;
      readonly status: string;
      readonly version: number;
      readonly listId: string;
      readonly spaceId: string;
    }
  | {
      readonly kind: 'list';
      readonly id: string;
      readonly name: string;
      readonly version: number;
      readonly spaceId: string;
    };
