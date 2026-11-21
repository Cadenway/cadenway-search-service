import { literalSearchOrderKey } from '../../../../../domain/policies/literal-search/literal-search-order.policy.js';
import {
  matchesLiteralSearch,
  normalizeLiteralSearchQuery,
} from '../../../../../domain/policies/literal-search/literal-search.policy.js';
import type { PaletteCandidate } from '../../../../models/palette/palette-candidate.model.js';
import type { PalettePosition } from '../../../../models/palette/palette-position.model.js';
import type { SearchDelegatedAuthority } from '../../../../ports/outbound/http/authority/search-delegated-authority.port.js';
import type { PaletteCursor } from '../../../../ports/outbound/pagination/palette/palette-cursor.port.js';
import type { PaletteCandidateReader } from '../../../../ports/outbound/search/palette/palette-candidate-reader.port.js';

import type { SearchPaletteInput } from './search-palette.input.js';
import type { SearchPaletteOutput } from './search-palette.output.js';

type Membership = NonNullable<Awaited<ReturnType<SearchDelegatedAuthority['getMembership']>>>;
type Evidence = Awaited<ReturnType<SearchDelegatedAuthority['resolveAccess']>>['results'][number];

/** Returns only indexed palette candidates confirmed by current organization and task authority. */
export class SearchPalette {
  // #region Constructor
  /** Receives the bounded index reader, current authority and authenticated cursor. */
  public constructor(
    private readonly candidates: PaletteCandidateReader,
    private readonly authority: SearchDelegatedAuthority,
    private readonly cursor: PaletteCursor,
  ) {}
  // #endregion

  // #region Methods
  /** Resolves a page, its visible lookahead and the final authority check within the request budget. */
  public async execute(input: SearchPaletteInput): Promise<SearchPaletteOutput> {
    const normalizedQuery = normalizeLiteralSearchQuery(input.query);
    if (
      input.userId.length === 0 ||
      input.organizationId.length === 0 ||
      normalizedQuery.length === 0 ||
      Array.from(input.query).length > 200 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 1024))
    )
      return { kind: 'invalid' };

    const binding = { userId: input.userId, organizationId: input.organizationId, normalizedQuery };
    try {
      if (input.signal?.aborted) return { kind: 'unavailable' };
      const position =
        input.cursor === undefined ? null : await this.cursor.decode(input.cursor, binding);
      if (input.cursor !== undefined && position === null) return { kind: 'invalid' };
      const membership = await this.authority.getMembership(
        input.organizationId,
        input.userId,
        input.signal,
      );
      if (membership === null) return { kind: 'not-found' };

      let generation: string | null = null;
      let after = position;
      const visible: PaletteCandidate[] = [];
      let finished = false;
      for (let page = 0; page < 50 && !finished && visible.length <= input.limit; page++) {
        if (input.signal?.aborted) return { kind: 'unavailable' };
        const result = await this.candidates.read({
          organizationId: input.organizationId,
          normalizedQuery,
          after,
          generation,
          limit: 100,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (
          !result.generation ||
          (generation !== null && generation !== result.generation) ||
          result.items.length > 100 ||
          (result.items.length === 0 && result.hasMore)
        ) {
          return { kind: 'unavailable' };
        }
        generation = result.generation;
        let previous = after;
        for (const item of result.items) {
          if (previous !== null && comparePositions(previous, item) >= 0)
            return { kind: 'unavailable' };
          literalSearchOrderKey(item.kind, item.id);
          previous = item;
        }
        if (result.items.length > 0) {
          const proofs = await this.authority.resolveAccess(
            input.organizationId,
            input.userId,
            {
              membership,
              candidates: result.items.map((item) => ({ kind: item.kind, id: item.id })),
            },
            input.signal,
          );
          const authorized = matchEvidence(result.items, proofs.results, false);
          for (const item of result.items) {
            if (
              authorized.has(key(item)) &&
              matchesLiteralSearch(
                normalizedQuery,
                item.name,
                item.kind === 'task' ? item.id : undefined,
              )
            ) {
              visible.push(item);
              if (visible.length > input.limit) break;
            }
          }
          after = previous;
        }
        finished = !result.hasMore;
      }
      if (visible.length <= input.limit && !finished) return { kind: 'unavailable' };

      // Task accepts at most 100 candidates. A full page plus its visible lookahead needs
      // two proofs. An empty page still verifies the membership stamp in Task.
      for (let offset = 0; offset < Math.max(visible.length, 1); offset += 100) {
        const batch = visible.slice(offset, offset + 100);
        const finalProof = await this.authority.resolveAccess(
          input.organizationId,
          input.userId,
          {
            membership,
            candidates: batch.map((item) => ({ kind: item.kind, id: item.id })),
          },
          input.signal,
        );
        if (
          matchEvidence(batch, finalProof.results, true).size !== batch.length ||
          input.signal?.aborted
        ) {
          return { kind: 'unavailable' };
        }
      }
      const latestMembership = await this.authority.getMembership(
        input.organizationId,
        input.userId,
        input.signal,
      );
      if (!sameMembership(membership, latestMembership) || input.signal?.aborted) {
        return { kind: 'unavailable' };
      }

      const selected = visible.slice(0, input.limit);
      let nextCursor: string | null = null;
      const last = selected[selected.length - 1];
      if (visible.length > input.limit && last !== undefined && generation !== null) {
        nextCursor = await this.cursor.encode({
          ...binding,
          after: { kind: last.kind, id: last.id },
        });
        if (nextCursor.length < 1 || nextCursor.length > 1024 || input.signal?.aborted)
          return { kind: 'unavailable' };
      }
      return {
        kind: 'ok',
        items: selected.map((item) =>
          item.kind === 'task'
            ? { kind: 'task' as const, taskKey: item.id, name: item.name, status: item.status }
            : { kind: 'list' as const, listId: item.id, name: item.name },
        ),
        nextCursor,
      };
    } catch {
      return { kind: 'unavailable' };
    }
  }
  // #endregion
}

function key(item: PalettePosition): string {
  return `${item.kind}:${item.id}`;
}

function comparePositions(left: PalettePosition, right: PalettePosition): number {
  const a = literalSearchOrderKey(left.kind, left.id);
  const b = literalSearchOrderKey(right.kind, right.id);
  for (let index = 0; index < a.length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function sameMembership(left: Membership, right: Membership | null): boolean {
  return (
    right !== null &&
    left.memberId === right.memberId &&
    left.role === right.role &&
    left.version === right.version
  );
}

function matchEvidence(
  items: readonly PaletteCandidate[],
  proofs: readonly Evidence[],
  requireCurrent: boolean,
): Set<string> {
  const indexed = new Map(items.map((item) => [key(item), item]));
  const positions = new Map(items.map((item, index) => [key(item), index]));
  const accepted = new Set<string>();
  const seen = new Set<string>();
  let lastPosition = -1;
  for (const proof of proofs) {
    if (proof.kind === 'space') throw new Error('Invalid search evidence.');
    const identity = key(proof);
    const candidate = indexed.get(identity);
    const position = positions.get(identity);
    if (
      candidate === undefined ||
      position === undefined ||
      position <= lastPosition ||
      seen.has(identity)
    )
      throw new Error('Invalid search evidence.');
    seen.add(identity);
    lastPosition = position;
    if (
      candidate.kind !== proof.kind ||
      candidate.version !== proof.version ||
      candidate.spaceId !== proof.spaceId ||
      (candidate.kind === 'task' && proof.kind === 'task' && candidate.listId !== proof.listId)
    ) {
      if (requireCurrent) throw new Error('Search evidence changed.');
      continue;
    }
    accepted.add(identity);
  }
  return accepted;
}
