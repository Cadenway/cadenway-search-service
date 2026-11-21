import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { literalSearchOrderKey } from '../../../domain/policies/literal-search/literal-search-order.policy.js';
import { literalSearchProbeTerms } from '../../../domain/policies/literal-search/literal-search.policy.js';

import { MeilisearchIndexAdapter } from './meilisearch-index.adapter.js';

const active = {
  id: '01938f6e-0000-7000-8000-000000000001',
  indexUid: 'generation-1',
  engineCreatedAt: '2026-11-21T00:48:12.123456Z',
};
const organizationId = '01938f6e-0000-7000-8000-000000000002';
const spaceId = '01938f6e-0000-7000-8000-000000000003';
const listId = '01938f6e-0000-7000-8000-000000000004';
const engineIndex = {
  uid: active.indexUid,
  createdAt: active.engineCreatedAt,
  primaryKey: 'projectionId',
};
const defaultInput = {
  organizationId,
  normalizedQuery: 'sprint 14',
  after: null,
  generation: null,
  limit: 1,
};

function taskHit(sourceId: string) {
  const [kindRank, orderHigh, orderMiddle, orderLow] = literalSearchOrderKey('task', sourceId);
  return {
    organizationId,
    projectionId: `${organizationId}_task_${sourceId}`,
    kind: 'task',
    sourceId,
    spaceId,
    listId,
    version: 3,
    title: 'Sprint 14',
    status: 'progress',
    kindRank,
    orderHigh,
    orderMiddle,
    orderLow,
  };
}

function result(hits: readonly unknown[], overrides: object = {}): Response {
  return Response.json({
    offset: 0,
    limit: 2,
    processingTimeMs: 1,
    estimatedTotalHits: 1200,
    ...overrides,
    hits,
  });
}

function setup(timeoutMs?: number) {
  const transport = vi.fn<typeof fetch>();
  const lookup = vi.fn<(signal: AbortSignal) => Promise<typeof active | null>>();
  lookup.mockResolvedValue(active);
  const adapter = new MeilisearchIndexAdapter({
    baseUrl: 'http://127.0.0.1:7700/meili',
    apiKey: 'test-engine-credential',
    fetch: transport,
    findActiveGeneration: lookup,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { adapter, transport, lookup };
}

describe('Meilisearch palette candidates', () => {
  it('applies offset-zero numeric keyset and literal filters without passing the raw query', async () => {
    const { adapter, transport, lookup } = setup();
    transport
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(result([taskHit('CAD-100'), taskHit('CAD-1000')]))
      .mockResolvedValueOnce(Response.json(engineIndex));

    await expect(
      adapter.read({
        ...defaultInput,
        generation: active.id,
        after: { kind: 'task', id: 'CAD-10' },
      }),
    ).resolves.toEqual({
      generation: active.id,
      hasMore: true,
      items: [
        {
          kind: 'task',
          id: 'CAD-100',
          name: 'Sprint 14',
          status: 'progress',
          version: 3,
          listId,
          spaceId,
        },
      ],
    });

    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET']);
    const [url, init] = transport.mock.calls[1] ?? [];
    expect(url).toEqual(new URL('http://127.0.0.1:7700/meili/indexes/generation-1/search'));
    expect(typeof init?.body).toBe('string');
    const raw = z.string().parse(init?.body);
    const sent = z
      .object({
        q: z.literal(''),
        offset: z.literal(0),
        limit: z.literal(2),
        filter: z.array(z.string()),
        sort: z.array(z.string()),
        attributesToRetrieve: z.array(z.string()),
      })
      .parse(JSON.parse(raw));
    expect(raw).not.toContain(defaultInput.normalizedQuery);
    expect(sent.sort).toEqual(['kindRank:asc', 'orderHigh:asc', 'orderMiddle:asc', 'orderLow:asc']);
    expect(sent.attributesToRetrieve).not.toContain('text');
    const keyset = sent.filter.at(-1);
    expect(sent.filter.slice(0, -1)).toEqual([
      `organizationId = "${organizationId}"`,
      'kind IN ["task","list"]',
      ...literalSearchProbeTerms(defaultInput.normalizedQuery).map(
        (term) => `literalTerms = "${term}"`,
      ),
    ]);
    const [rank, high, middle, low] = literalSearchOrderKey('task', 'CAD-10');
    expect(keyset).toBe(
      `((kindRank > ${String(rank)}) OR (kindRank = ${String(rank)} AND orderHigh > ${String(high)}) OR (kindRank = ${String(rank)} AND orderHigh = ${String(high)} AND orderMiddle > ${String(middle)}) OR (kindRank = ${String(rank)} AND orderHigh = ${String(high)} AND orderMiddle = ${String(middle)} AND orderLow > ${String(low)}))`,
    );
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0]?.[0]).toBe(init?.signal);
    expect(lookup.mock.calls[1]?.[0]).toBe(init?.signal);
  });

  it.each([
    [
      'foreign tenant lookahead',
      [taskHit('CAD-1'), { ...taskHit('CAD-2'), organizationId: listId }],
    ],
    ['forged projection identifier', [{ ...taskHit('CAD-1'), projectionId: 'other' }]],
    ['forged sort key', [{ ...taskHit('CAD-1'), orderLow: 1 }]],
    ['repeated sort key', [taskHit('CAD-1'), taskHit('CAD-1')]],
    ['invalid status', [{ ...taskHit('CAD-1'), status: 'invented' }]],
    ['invalid placement', [{ ...taskHit('CAD-1'), spaceId: 'invalid' }]],
    ['noncandidate kind', [{ ...taskHit('CAD-1'), kind: 'document' }]],
  ])('refuses invalid engine data for %s', async (_case, hits) => {
    const { adapter, transport } = setup();
    transport.mockResolvedValueOnce(Response.json(engineIndex)).mockResolvedValueOnce(result(hits));
    await expect(adapter.read(defaultInput)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('rejects an obsolete continuation before calling Meilisearch', async () => {
    const { adapter, transport } = setup();
    await expect(adapter.read({ ...defaultInput, generation: listId })).rejects.toMatchObject({
      code: 'index-replaced',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a response from an index replaced or deactivated during the call', async () => {
    const { adapter, transport, lookup } = setup();
    lookup.mockResolvedValueOnce(active).mockResolvedValueOnce(null);
    transport
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        Response.json({ ...engineIndex, createdAt: '2026-11-21T00:48:12.123457Z' }),
      );
    await expect(adapter.read(defaultInput)).rejects.toMatchObject({ code: 'index-replaced' });
    await expect(adapter.read(defaultInput)).rejects.toMatchObject({ code: 'index-replaced' });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('fails closed at the engine cutoff or the response byte ceiling', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(result([], { processingTimeMs: 1_500 }))
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(result([], { padding: 'a'.repeat(262_144) }));
    await expect(adapter.read(defaultInput)).rejects.toMatchObject({ code: 'timeout' });
    await expect(adapter.read(defaultInput)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('can read the largest valid candidate count with supplementary Unicode titles', async () => {
    const { adapter, transport } = setup();
    const title = '🔎'.repeat(300);
    const hits = Array.from({ length: 101 }, (_, i) => ({
      ...taskHit(`CAD-${String(i + 100)}`),
      title,
    }));
    transport
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(result(hits, { limit: 101 }))
      .mockResolvedValueOnce(Response.json(engineIndex));
    const page = await adapter.read({ ...defaultInput, limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.items[99]?.name).toBe(title);
    expect(page.hasMore).toBe(true);
  });

  it('returns within the operation deadline even when active-pointer lookup is stalled', async () => {
    const { adapter, transport, lookup } = setup(50);
    lookup.mockImplementation(() => new Promise(() => undefined));
    await expect(adapter.read(defaultInput)).rejects.toMatchObject({ code: 'timeout' });
    expect(transport).not.toHaveBeenCalled();
    expect(lookup.mock.calls[0]?.[0].aborted).toBe(true);
  });
});
