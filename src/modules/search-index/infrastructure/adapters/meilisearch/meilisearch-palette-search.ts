import { STATUS_KEYS } from '@cadenway/contracts';
import {
  listTaskSearchProjectionsInternalResponseItemsItemOneNameMax as maxTaskNameCodePoints,
  listTaskSearchProjectionsInternalResponseItemsItemTwoNameMax as maxListNameCodePoints,
} from '@cadenway/contracts/validators/internal/task-service';
import type { SearchParams } from 'meilisearch';
import { z } from 'zod';

import type { PaletteCandidate } from '../../../application/models/palette/palette-candidate.model.js';
import type { PalettePosition } from '../../../application/models/palette/palette-position.model.js';
import { literalSearchProbeTerms } from '../../../domain/policies/literal-search/literal-search.policy.js';

import { MeilisearchIndexError } from './meilisearch-index.error.js';
import {
  assertMeilisearchKeysetWindow,
  buildMeilisearchKeysetRequest,
  checkMeilisearchKeysetHit,
  MEILISEARCH_KEYSET_HIT_FIELDS,
  MEILISEARCH_KEYSET_LIMIT,
  MEILISEARCH_KEYSET_RESPONSE_FIELDS,
  MEILISEARCH_ORDERED_KINDS,
  meilisearchOrderKey,
} from './meilisearch-keyset-search.js';
import { MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS } from './meilisearch-literal-search-sort-fields.js';

const resourceUuid = z.uuidv7().transform((value) => value.toLowerCase());
const hitFields = {
  ...MEILISEARCH_KEYSET_HIT_FIELDS,
  version: z.int().positive(),
  spaceId: resourceUuid,
};
const hit = z.discriminatedUnion('kind', [
  z.strictObject({
    ...hitFields,
    kind: z.literal('task'),
    kindRank: z.literal(0),
    sourceId: z.string().min(1).max(15),
    title: z.string().min(1).max(maxTaskNameCodePoints),
    status: z.enum(STATUS_KEYS),
    listId: resourceUuid,
  }),
  z.strictObject({
    ...hitFields,
    kind: z.literal('list'),
    kindRank: z.literal(1),
    sourceId: resourceUuid,
    title: z.string().min(1).max(maxListNameCodePoints),
  }),
]);
const searchResponse = z.object({
  ...MEILISEARCH_KEYSET_RESPONSE_FIELDS,
  hits: z.array(hit).max(MEILISEARCH_KEYSET_LIMIT + 1),
});

const retrieveFields = [
  'projectionId',
  'organizationId',
  'kind',
  'sourceId',
  'version',
  'title',
  'status',
  'listId',
  'spaceId',
  ...MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS,
];

/** Builds one offset-zero query that resumes after an exact, proven sort position. */
export function buildMeilisearchPaletteRequest(
  organizationId: string,
  normalizedQuery: string,
  after: PalettePosition | null,
  limit: number,
): SearchParams {
  // Lowercasing a 200-code-point request can expand it to 400 UTF-16 units.
  if (normalizedQuery.length === 0 || normalizedQuery.length > 400) {
    throw new MeilisearchIndexError('invalid-request');
  }
  const filter = [
    `organizationId = ${JSON.stringify(organizationId)}`,
    `kind IN ${JSON.stringify(MEILISEARCH_ORDERED_KINDS)}`,
    ...literalSearchProbeTerms(normalizedQuery).map(
      (term) => `literalTerms = ${JSON.stringify(term)}`,
    ),
  ];
  return buildMeilisearchKeysetRequest(filter, after, limit, retrieveFields);
}

/** Checks every candidate including the withheld lookahead before returning any of the page. */
export function readMeilisearchPaletteResponse(
  body: unknown,
  organizationId: string,
  after: PalettePosition | null,
  limit: number,
): readonly PaletteCandidate[] {
  const parsed = searchResponse.safeParse(body);
  if (!parsed.success) throw new MeilisearchIndexError('invalid-response');
  assertMeilisearchKeysetWindow(parsed.data, limit);
  let previous = after === null ? null : meilisearchOrderKey(after, 'invalid-request');
  return parsed.data.hits.map((value): PaletteCandidate => {
    previous = checkMeilisearchKeysetHit(value, organizationId, previous);
    const item = {
      id: value.sourceId,
      name: value.title,
      version: value.version,
      spaceId: value.spaceId,
    };
    return value.kind === 'task'
      ? { ...item, kind: 'task', status: value.status, listId: value.listId }
      : { ...item, kind: 'list' };
  });
}
