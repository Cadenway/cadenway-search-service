import type { SearchParams } from 'meilisearch';
import { z } from 'zod';

import type { PalettePosition } from '../../../application/models/palette/palette-position.model.js';
import { LiteralSearchOrderError } from '../../../domain/errors/literal-search/literal-search-order.error.js';
import { literalSearchOrderKey } from '../../../domain/policies/literal-search/literal-search-order.policy.js';
import type { LiteralSearchOrderKey } from '../../../domain/value-objects/literal-search/literal-search-order-key.value-object.js';

import { MeilisearchIndexError } from './meilisearch-index.error.js';
import { MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS } from './meilisearch-literal-search-sort-fields.js';

/** Engine cutoff configured on every generation that uses the numeric keyset. */
export const MEILISEARCH_SEARCH_CUTOFF_MS = 1_500;

/** Maximum number of candidates returned to the caller per engine query. */
export const MEILISEARCH_KEYSET_LIMIT = 100;

/** Resource kinds represented by numeric order metadata. */
export const MEILISEARCH_ORDERED_KINDS = ['task', 'list'] as const;

const orderedKind = z.enum(MEILISEARCH_ORDERED_KINDS);
const chunk = z
  .int()
  .min(0)
  .max(2 ** 48 - 1);

/** Minimal engine fields required to validate a candidate locator and its numeric order. */
export const MEILISEARCH_KEYSET_HIT_FIELDS = {
  projectionId: z.string().min(1).max(78),
  organizationId: z.uuid().transform((value) => value.toLowerCase()),
  kind: orderedKind,
  sourceId: z.string().min(1).max(36),
  kindRank: z.union([z.literal(0), z.literal(1)]),
  orderHigh: chunk,
  orderMiddle: chunk,
  orderLow: chunk,
};

/** Shared response fields for an observed offset-zero engine result. */
export const MEILISEARCH_KEYSET_RESPONSE_FIELDS = {
  offset: z.literal(0),
  limit: z
    .int()
    .min(2)
    .max(MEILISEARCH_KEYSET_LIMIT + 1),
  processingTimeMs: z.int().nonnegative(),
  degraded: z.literal(false).optional(),
};

/** Derives a canonical order tuple and classifies invalid inputs at the engine boundary. */
export function meilisearchOrderKey(
  position: PalettePosition,
  errorCode: 'invalid-request' | 'invalid-response',
): LiteralSearchOrderKey {
  if (!orderedKind.safeParse(position.kind).success) throw new MeilisearchIndexError(errorCode);
  try {
    return literalSearchOrderKey(position.kind, position.id);
  } catch (error: unknown) {
    if (error instanceof LiteralSearchOrderError) throw new MeilisearchIndexError(errorCode);
    throw error;
  }
}

function orderAfter(key: LiteralSearchOrderKey): string {
  const equalities: string[] = [];
  const branches = key.map((component, index) => {
    const field = MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS[index];
    if (field === undefined) throw new MeilisearchIndexError('invalid-request');
    const value = component.toString(10);
    const branch = [...equalities, `${field} > ${value}`].join(' AND ');
    equalities.push(`${field} = ${value}`);
    return `(${branch})`;
  });
  return `(${branches.join(' OR ')})`;
}

function compareOrder(left: LiteralSearchOrderKey, right: LiteralSearchOrderKey): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3] - right[3];
}

/** Builds an offset-zero engine request with a single withheld lookahead. */
export function buildMeilisearchKeysetRequest(
  filter: readonly string[],
  after: PalettePosition | null,
  limit: number,
  attributesToRetrieve: readonly string[],
): SearchParams {
  if (!Number.isInteger(limit) || limit < 1 || limit > MEILISEARCH_KEYSET_LIMIT) {
    throw new MeilisearchIndexError('invalid-request');
  }
  const scopedFilter = [...filter];
  if (after !== null) scopedFilter.push(orderAfter(meilisearchOrderKey(after, 'invalid-request')));
  return {
    q: '',
    filter: scopedFilter,
    sort: MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS.map((field) => `${field}:asc`),
    attributesToRetrieve: [...attributesToRetrieve],
    offset: 0,
    limit: limit + 1,
  };
}

/** Refuses inconsistent paging metadata or an engine response that reached its cutoff. */
export function assertMeilisearchKeysetWindow(
  value: {
    readonly limit: number;
    readonly hits: readonly unknown[];
    readonly processingTimeMs: number;
  },
  limit: number,
): void {
  if (value.limit !== limit + 1 || value.hits.length > limit + 1) {
    throw new MeilisearchIndexError('invalid-response');
  }
  if (value.processingTimeMs >= MEILISEARCH_SEARCH_CUTOFF_MS) {
    throw new MeilisearchIndexError('timeout');
  }
}

/** Checks locator identity, organization and strict order through the page's lookahead. */
export function checkMeilisearchKeysetHit(
  value: z.infer<z.ZodObject<typeof MEILISEARCH_KEYSET_HIT_FIELDS>>,
  organizationId: string,
  previous: LiteralSearchOrderKey | null,
): LiteralSearchOrderKey {
  const expected = meilisearchOrderKey(
    { kind: value.kind, id: value.sourceId },
    'invalid-response',
  );
  const stored = [value.kindRank, value.orderHigh, value.orderMiddle, value.orderLow] as const;
  if (
    value.organizationId !== organizationId ||
    value.projectionId !== `${organizationId}_${value.kind}_${value.sourceId}` ||
    compareOrder(expected, stored) !== 0 ||
    (previous !== null && compareOrder(previous, stored) >= 0)
  ) {
    throw new MeilisearchIndexError('invalid-response');
  }
  return stored;
}
