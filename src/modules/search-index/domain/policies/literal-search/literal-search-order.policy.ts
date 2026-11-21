import { LiteralSearchOrderError } from '../../errors/literal-search/literal-search-order.error.js';
import type { LiteralSearchOrderKey } from '../../value-objects/literal-search/literal-search-order-key.value-object.js';

const taskKeyPattern = /^[A-Z]{2,5}-[1-9][0-9]{0,8}$/u;
const listIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const taskChunkWidth = 6;
const uuidChunkWidth = 12;

/**
 * Encodes the order required by GET /v1/search: tasks first, then lists, each by ascending ID.
 * The input is the canonical TaskKey or list UUID from the corresponding search hit contract.
 *
 * @throws {LiteralSearchOrderError} The identifier does not fit its contract's order encoding.
 */
export function literalSearchOrderKey(kind: 'task' | 'list', id: string): LiteralSearchOrderKey {
  if (kind === 'task') {
    if (!taskKeyPattern.test(id)) throw new LiteralSearchOrderError('Invalid task key.');

    // TaskKey is at most 15 ASCII characters. A zero byte preserves lexical prefix ordering.
    const padded = id.padEnd(taskChunkWidth * 3, '\u0000');
    return [
      0,
      encodeTaskChunk(padded, 0),
      encodeTaskChunk(padded, taskChunkWidth),
      encodeTaskChunk(padded, taskChunkWidth * 2),
    ];
  }

  if (!listIdPattern.test(id)) throw new LiteralSearchOrderError('Invalid list identifier.');

  // All 32 hexadecimal digits matter, including the last eight in the third chunk.
  const hex = id.replaceAll('-', '');
  return [
    1,
    Number.parseInt(hex.slice(0, uuidChunkWidth), 16),
    Number.parseInt(hex.slice(uuidChunkWidth, uuidChunkWidth * 2), 16),
    Number.parseInt(hex.slice(uuidChunkWidth * 2), 16),
  ];
}

function encodeTaskChunk(padded: string, offset: number): number {
  let value = 0;
  for (let index = offset; index < offset + taskChunkWidth; index++) {
    value = value * 256 + padded.charCodeAt(index);
  }
  return value;
}
