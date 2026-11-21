/** A lexicographic palette sort key with three exact unsigned integer chunks of up to 48 bits. */
export type LiteralSearchOrderKey = readonly [
  kindRank: 0 | 1,
  high: number,
  middle: number,
  low: number,
];
