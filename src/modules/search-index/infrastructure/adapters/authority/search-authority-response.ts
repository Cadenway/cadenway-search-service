import type { SearchAuthorityModel } from '../../../application/models/authority/search-authority.model.js';
import { SearchAuthorityReadError } from '../../../domain/errors/authority/search-authority-read.error.js';

const MAX_CURSOR_LENGTH = 1024;

/** Prove that a page stays within its requested size and can make forward progress. */
export function assertAuthorityPage(
  page: { readonly items: readonly unknown[]; readonly nextCursor: string | null },
  query: { readonly cursor?: string | undefined; readonly limit: number },
  ids: readonly string[],
  orderedById: boolean,
): void {
  const { items, nextCursor } = page;
  const invalidContinuation =
    nextCursor !== null &&
    (nextCursor === '' ||
      nextCursor.length > MAX_CURSOR_LENGTH ||
      nextCursor === query.cursor ||
      items.length === 0);
  if (items.length > query.limit || invalidContinuation || new Set(ids).size !== ids.length) {
    throw new SearchAuthorityReadError('unavailable');
  }
  if (orderedById && ids.some((id, index) => index > 0 && id <= (ids[index - 1] ?? ''))) {
    throw new SearchAuthorityReadError('unavailable');
  }
}

/** Use canonical UUID identities while preserving the spelling of a stable Task key. */
export function taskAuthorityId(kind: SearchAuthorityModel['kind'], id: string): string {
  return kind === 'task' ? id : id.toLowerCase();
}

/** Reject input indices that collapse to the same authoritative identity. */
export function assertUniqueAuthorityIds(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new SearchAuthorityReadError('invalid-request');
}

/** Require exactly one matching decision per requested identity in the original order. */
export function assertOrderedAuthorityDecisions(
  requested: readonly string[],
  received: readonly string[],
): void {
  if (
    requested.length !== received.length ||
    received.some((id, index) => id !== requested[index])
  ) {
    throw new SearchAuthorityReadError('unavailable');
  }
}

/** Form a proof selector from a kind and its normalized identifier. */
export function taskAuthoritySelector(candidate: {
  readonly kind: SearchAuthorityModel['kind'];
  readonly id: string;
}): string {
  return `${candidate.kind}:${taskAuthorityId(candidate.kind, candidate.id)}`;
}

/** Require a unique ascending subsequence of the delegated request. */
export function assertAuthorityProof(
  requested: readonly string[],
  received: readonly string[],
): void {
  const positions = new Map(requested.map((item, index) => [item, index]));
  let previous = -1;
  for (const id of received) {
    const position = positions.get(id);
    if (position === undefined || position <= previous)
      throw new SearchAuthorityReadError('unavailable');
    previous = position;
  }
}
