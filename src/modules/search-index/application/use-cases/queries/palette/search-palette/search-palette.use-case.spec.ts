import { describe, expect, it, vi } from 'vitest';

import type { PaletteCandidate } from '../../../../models/palette/palette-candidate.model.js';
import type { SearchDelegatedAuthority } from '../../../../ports/outbound/http/authority/search-delegated-authority.port.js';
import type { PaletteCursor } from '../../../../ports/outbound/pagination/palette/palette-cursor.port.js';
import type { PaletteCandidateReader } from '../../../../ports/outbound/search/palette/palette-candidate-reader.port.js';

import { SearchPalette } from './search-palette.use-case.js';

const membership = { memberId: 'member-1', role: 'member' as const, version: 1 };
const input = { organizationId: 'org-1', userId: 'user-1', query: 'SSO', limit: 1 };
const task = (id: string): PaletteCandidate => ({
  kind: 'task',
  id,
  name: 'Connexion SSO',
  status: 'progress',
  version: 1,
  listId: 'list-1',
  spaceId: 'space-1',
});
const proof = (id: string) => ({
  kind: 'task' as const,
  id,
  version: 1,
  listId: 'list-1',
  spaceId: 'space-1',
});

function fixture(items: readonly PaletteCandidate[]) {
  const read = vi
    .fn<PaletteCandidateReader['read']>()
    .mockResolvedValue({ generation: 'gen-1', items, hasMore: false });
  const getMembership = vi
    .fn<SearchDelegatedAuthority['getMembership']>()
    .mockResolvedValue(membership);
  const resolveAccess = vi
    .fn<SearchDelegatedAuthority['resolveAccess']>()
    .mockImplementation((_org, _user, lookup) =>
      Promise.resolve({ results: lookup.candidates.map((candidate) => proof(candidate.id)) }),
    );
  const decode = vi.fn<PaletteCursor['decode']>().mockResolvedValue(null);
  const encode = vi.fn<PaletteCursor['encode']>().mockResolvedValue('sealed');
  return {
    read,
    getMembership,
    resolveAccess,
    decode,
    encode,
    search: new SearchPalette({ read }, { getMembership, resolveAccess }, { decode, encode }),
  };
}

describe('SearchPalette', () => {
  it('does not issue a continuation for a hidden lookahead', async () => {
    const { search, resolveAccess, encode } = fixture([task('CAD-1'), task('CAD-2')]);
    resolveAccess.mockResolvedValue({ results: [proof('CAD-1')] });
    expect(await search.execute(input)).toEqual({
      kind: 'ok',
      items: [{ kind: 'task', taskKey: 'CAD-1', name: 'Connexion SSO', status: 'progress' }],
      nextCursor: null,
    });
    expect(encode).not.toHaveBeenCalled();
  });

  it('binds the cursor to the last visible result and verifies its lookahead', async () => {
    const { search, resolveAccess, encode } = fixture([task('CAD-1'), task('CAD-2')]);
    const result = await search.execute(input);
    expect(result.kind).toBe('ok');
    expect(encode).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      normalizedQuery: 'sso',
      after: { kind: 'task', id: 'CAD-1' },
    });
    expect(resolveAccess).toHaveBeenCalledTimes(2);
    expect(resolveAccess.mock.calls[1]?.[2].candidates).toHaveLength(2);
  });

  it('skips stale indexed metadata and returns an adjacent current candidate', async () => {
    const { search, resolveAccess } = fixture([task('CAD-1'), task('CAD-2')]);
    resolveAccess
      .mockResolvedValueOnce({ results: [{ ...proof('CAD-1'), version: 2 }, proof('CAD-2')] })
      .mockResolvedValueOnce({ results: [proof('CAD-2')] });
    expect(await search.execute(input)).toEqual({
      kind: 'ok',
      items: [{ kind: 'task', taskKey: 'CAD-2', name: 'Connexion SSO', status: 'progress' }],
      nextCursor: null,
    });
  });

  it('resumes a cursor on the currently active generation after a generation switch', async () => {
    const { search, decode, read } = fixture([task('CAD-2')]);
    decode.mockResolvedValue({ kind: 'task', id: 'CAD-1' });
    read.mockResolvedValue({ generation: 'gen-2', items: [task('CAD-2')], hasMore: false });
    expect((await search.execute({ ...input, cursor: 'sealed' })).kind).toBe('ok');
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      generation: null,
      after: { kind: 'task', id: 'CAD-1' },
    });
  });

  it('rejects duplicated or out-of-order authority evidence', async () => {
    const { search, resolveAccess } = fixture([task('CAD-1'), task('CAD-2')]);
    resolveAccess.mockResolvedValue({ results: [proof('CAD-2'), proof('CAD-1')] });
    expect(await search.execute(input)).toEqual({ kind: 'unavailable' });
  });

  it('rechecks a full page and its lookahead in batches of at most 100', async () => {
    const ordered = Array.from({ length: 101 }, (_, index) => `CAD-${String(index + 1)}`)
      .sort()
      .map(task);
    const { search, read, resolveAccess, getMembership } = fixture([]);
    read
      .mockResolvedValueOnce({ generation: 'gen-1', items: ordered.slice(0, 100), hasMore: true })
      .mockResolvedValueOnce({ generation: 'gen-1', items: ordered.slice(100), hasMore: false });

    const result = await search.execute({ ...input, limit: 100 });

    expect(result.kind).toBe('ok');
    expect(resolveAccess.mock.calls.map((call) => call[2].candidates.length)).toEqual([
      100, 1, 100, 1,
    ]);
    expect(getMembership).toHaveBeenCalledTimes(2);
    expect(getMembership.mock.invocationCallOrder[1]).toBeGreaterThan(
      resolveAccess.mock.invocationCallOrder[3] ?? 0,
    );
  });

  it('fails closed if the membership changes during the request', async () => {
    const { search, getMembership, encode } = fixture([task('CAD-1'), task('CAD-2')]);
    getMembership
      .mockResolvedValueOnce(membership)
      .mockResolvedValueOnce({ ...membership, version: 2 });
    expect(await search.execute(input)).toEqual({ kind: 'unavailable' });
    expect(encode).not.toHaveBeenCalled();
  });

  it('fails closed if a previously authorized result changes placement', async () => {
    const { search, resolveAccess } = fixture([task('CAD-1')]);
    resolveAccess
      .mockResolvedValueOnce({ results: [proof('CAD-1')] })
      .mockResolvedValueOnce({ results: [{ ...proof('CAD-1'), listId: 'list-2' }] });
    expect(await search.execute(input)).toEqual({ kind: 'unavailable' });
  });

  it('checks membership for an empty index and refuses a missing member', async () => {
    const { search, read, getMembership } = fixture([]);
    getMembership.mockResolvedValue(null);
    expect(await search.execute(input)).toEqual({ kind: 'not-found' });
    expect(read).not.toHaveBeenCalled();
  });

  it('discloses a visible list without exposing an unproven parent name', async () => {
    const id = '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01';
    const { search, resolveAccess } = fixture([
      { kind: 'list', id, name: 'SSO', version: 3, spaceId: 'space-1' },
    ]);
    resolveAccess.mockResolvedValue({
      results: [{ kind: 'list', id, version: 3, spaceId: 'space-1' }],
    });
    expect(await search.execute(input)).toEqual({
      kind: 'ok',
      items: [{ kind: 'list', listId: id, name: 'SSO' }],
      nextCursor: null,
    });
  });
});
