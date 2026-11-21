import type { SearchParams } from 'meilisearch';
import { z } from 'zod';

import type { PalettePosition } from '../../../application/models/palette/palette-position.model.js';
import type { SearchParentDescendantReader } from '../../../application/ports/outbound/search/rebuild/search-parent-descendant-reader.port.js';

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

const cursorMax = 1024;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const resourceUuid = z.uuidv7().transform((value) => value.toLowerCase());
const scopeSchema = z.strictObject({
  generationId: uuid,
  indexUid: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
  engineCreatedAt: z.iso.datetime({ offset: true }),
  organizationId: uuid,
  kind: z.enum(['list', 'space']),
  sourceId: resourceUuid,
});
type ParentScope = z.output<typeof scopeSchema>;

const cursorSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  after: z.strictObject({ kind: z.enum(MEILISEARCH_ORDERED_KINDS), id: z.string().max(36) }),
});

const hitFields = { ...MEILISEARCH_KEYSET_HIT_FIELDS, spaceId: resourceUuid };
const descendant = z.discriminatedUnion('kind', [
  z.strictObject({ ...hitFields, kind: z.literal('task'), listId: resourceUuid }),
  z.strictObject({ ...hitFields, kind: z.literal('list'), sourceId: resourceUuid }),
]);
const descendantsResponse = z.object({
  ...MEILISEARCH_KEYSET_RESPONSE_FIELDS,
  hits: z.array(descendant).max(MEILISEARCH_KEYSET_LIMIT + 1),
});
const locatorAttributes = [...Object.keys(MEILISEARCH_KEYSET_HIT_FIELDS), 'listId', 'spaceId'];

function decodeContinuation(value: string, scope: ParentScope): PalettePosition {
  if (value.length > cursorMax || !/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new MeilisearchIndexError('invalid-request');
  }
  let body: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Invalid encoding.');
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new MeilisearchIndexError('invalid-request');
  }
  const parsed = cursorSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.scope.generationId !== scope.generationId ||
    parsed.data.scope.indexUid !== scope.indexUid ||
    parsed.data.scope.engineCreatedAt !== scope.engineCreatedAt ||
    parsed.data.scope.organizationId !== scope.organizationId ||
    parsed.data.scope.kind !== scope.kind ||
    parsed.data.scope.sourceId !== scope.sourceId ||
    (scope.kind === 'list' && parsed.data.after.kind !== 'task')
  ) {
    throw new MeilisearchIndexError('invalid-request');
  }
  return parsed.data.after;
}

/** Binds the stored continuation to the precise parent and generation before any engine call. */
export function buildMeilisearchDescendantsRequest(
  input: Parameters<SearchParentDescendantReader['read']>[0],
): {
  readonly scope: ParentScope;
  readonly after: PalettePosition | null;
  readonly request: SearchParams;
} {
  const scope = scopeSchema.safeParse({
    generationId: input.generation.id,
    indexUid: input.generation.indexUid,
    engineCreatedAt: input.generation.engineCreatedAt,
    organizationId: input.parent.organizationId,
    kind: input.parent.kind,
    sourceId: input.parent.sourceId,
  });
  if (!scope.success) throw new MeilisearchIndexError('invalid-request');
  const { organizationId, kind, sourceId } = scope.data;
  const after = input.cursor === null ? null : decodeContinuation(input.cursor, scope.data);
  const filters = [
    `organizationId = ${JSON.stringify(organizationId)}`,
    kind === 'list' ? 'kind = "task"' : `kind IN ${JSON.stringify(MEILISEARCH_ORDERED_KINDS)}`,
    `${kind === 'list' ? 'listId' : 'spaceId'} = ${JSON.stringify(sourceId)}`,
  ];
  return {
    scope: scope.data,
    after,
    request: buildMeilisearchKeysetRequest(filters, after, input.limit, locatorAttributes),
  };
}

/** Checks each bound descendant and returns the locators and their durable continuation. */
export function readMeilisearchDescendantsResponse(
  body: unknown,
  scope: ParentScope,
  after: PalettePosition | null,
  limit: number,
): Awaited<ReturnType<SearchParentDescendantReader['read']>> {
  const parsed = descendantsResponse.safeParse(body);
  if (!parsed.success) throw new MeilisearchIndexError('invalid-response');
  assertMeilisearchKeysetWindow(parsed.data, limit);
  let previous = after === null ? null : meilisearchOrderKey(after, 'invalid-request');
  const locators = parsed.data.hits.map((value) => {
    if (
      (scope.kind === 'list' && (value.kind !== 'task' || value.listId !== scope.sourceId)) ||
      (scope.kind === 'space' && value.spaceId !== scope.sourceId)
    ) {
      throw new MeilisearchIndexError('invalid-response');
    }
    previous = checkMeilisearchKeysetHit(value, scope.organizationId, previous);
    return { organizationId: scope.organizationId, kind: value.kind, sourceId: value.sourceId };
  });
  const items = locators.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    locators.length > limit && last !== undefined
      ? Buffer.from(
          JSON.stringify({ version: 1, scope, after: { kind: last.kind, id: last.sourceId } }),
          'utf8',
        ).toString('base64url')
      : null;
  return { items, nextCursor };
}
