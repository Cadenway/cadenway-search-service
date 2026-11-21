import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LiteralSearchOrderError } from '../../errors/literal-search/literal-search-order.error.js';
import type { LiteralSearchOrderKey } from '../../value-objects/literal-search/literal-search-order-key.value-object.js';
import { literalSearchOrderKey } from './literal-search-order.policy.js';

function compareOrderKeys(left: LiteralSearchOrderKey, right: LiteralSearchOrderKey): number {
  const [leftKind, leftHigh, leftMiddle, leftLow] = left;
  const [rightKind, rightHigh, rightMiddle, rightLow] = right;
  return (
    leftKind - rightKind || leftHigh - rightHigh || leftMiddle - rightMiddle || leftLow - rightLow
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left === right ? 0 : 1;
}

function hex(value: bigint, width: number): string {
  return value.toString(16).padStart(width, '0');
}

describe('literalSearchOrderKey', () => {
  it('orders tasks before lists and sorts by lexical task key including prefixes', () => {
    const task = (id: string): LiteralSearchOrderKey => literalSearchOrderKey('task', id);
    const list = literalSearchOrderKey('list', '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01');
    expect(compareOrderKeys(task('ZZZZZ-999999999'), list)).toBeLessThan(0);
    expect(compareOrderKeys(task('ZZZZZ-999999998'), task('ZZZZZ-999999999'))).toBeLessThan(0);
    expect(compareOrderKeys(task('CAD-4'), task('CAD-482'))).toBeLessThan(0);
    expect(compareOrderKeys(task('CAD-482'), task('CAD-8'))).toBeLessThan(0);
    expect(compareOrderKeys(task('CAD-1'), task('CADA-1'))).toBeLessThan(0);
  });

  it('preserves the lowest UUID digits and normalizes the canonical hex alphabet', () => {
    const first = '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01';
    const second = '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e02';
    const representative = literalSearchOrderKey('list', first);
    expect(representative).toEqual(literalSearchOrderKey('list', first.toUpperCase()));
    expect(compareOrderKeys(representative, literalSearchOrderKey('list', second))).toBeLessThan(0);
  });

  it('refuses invalid task keys and UUIDs before producing a potentially colliding key', () => {
    expect(() => literalSearchOrderKey('task', 'CAD-0001')).toThrow(LiteralSearchOrderError);
    expect(() => literalSearchOrderKey('task', 'CAD-9999999999')).toThrow(LiteralSearchOrderError);
    expect(() => literalSearchOrderKey('list', '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e0')).toThrow(
      LiteralSearchOrderError,
    );
  });

  it('preserves complete lexical ordering with integer chunks for task and list keys', () => {
    const taskKey = fc
      .tuple(
        fc.array(fc.integer({ min: 65, max: 90 }), { minLength: 2, maxLength: 5 }),
        fc.integer({ min: 1, max: 999_999_999 }),
      )
      .map(([prefix, number]) => `${String.fromCharCode(...prefix)}-${number.toString(10)}`);
    const listId = fc
      .tuple(
        fc.bigInt({ min: 0n, max: 0xffffffffffffn }),
        fc.bigInt({ min: 0n, max: 0xfffn }),
        fc.bigInt({ min: 0n, max: 0x3fffn }),
        fc.bigInt({ min: 0n, max: 0xffffffffffffn }),
      )
      .map(([prefix, version, variant, suffix]) => {
        const time = hex(prefix, 12);
        return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(version, 3)}-${hex(0x8000n + variant, 4)}-${hex(suffix, 12)}`;
      });

    fc.assert(
      fc.property(taskKey, taskKey, listId, listId, (leftTask, rightTask, leftList, rightList) => {
        const leftTaskOrder = literalSearchOrderKey('task', leftTask);
        const rightTaskOrder = literalSearchOrderKey('task', rightTask);
        const leftListOrder = literalSearchOrderKey('list', leftList);
        const rightListOrder = literalSearchOrderKey('list', rightList);

        expect(Math.sign(compareOrderKeys(leftTaskOrder, rightTaskOrder))).toBe(
          compareStrings(leftTask, rightTask),
        );
        expect(Math.sign(compareOrderKeys(leftListOrder, rightListOrder))).toBe(
          compareStrings(leftList, rightList),
        );
        for (const part of [...leftTaskOrder, ...leftListOrder]) {
          expect(Number.isSafeInteger(part) && part >= 0 && part < 2 ** 48).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
