import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { literalSearchOrderKey } from '../../../domain/policies/literal-search/literal-search-order.policy.js';

import { MeilisearchIndexAdapter } from './meilisearch-index.adapter.js';

const generation = {
  id: '01938f6e-0000-7000-8000-000000000001',
  indexUid: 'generation-1',
  engineCreatedAt: '2026-11-21T00:48:12.123456Z',
};
const organizationId = '01938f6e-0000-7000-8000-000000000002';
const spaceId = '01938f6e-0000-7000-8000-000000000003';
const listId = '01938f6e-0000-7000-8000-000000000004';
const otherId = '01938f6e-0000-7000-8000-000000000005';
const index = {
  uid: generation.indexUid,
  createdAt: generation.engineCreatedAt,
  primaryKey: 'projectionId',
};
const listScope = {
  generation,
  parent: { organizationId, kind: 'list' as const, sourceId: listId },
  limit: 1,
  cursor: null,
};

function task(sourceId: string) {
  const [kindRank, orderHigh, orderMiddle, orderLow] = literalSearchOrderKey('task', sourceId);
  return {
    organizationId,
    projectionId: `${organizationId}_task_${sourceId}`,
    kind: 'task',
    sourceId,
    spaceId,
    listId,
    kindRank,
    orderHigh,
    orderMiddle,
    orderLow,
  };
}

function list(sourceId: string) {
  const [kindRank, orderHigh, orderMiddle, orderLow] = literalSearchOrderKey('list', sourceId);
  return {
    organizationId,
    projectionId: `${organizationId}_list_${sourceId}`,
    kind: 'list',
    sourceId,
    spaceId,
    kindRank,
    orderHigh,
    orderMiddle,
    orderLow,
  };
}

function setup() {
  const transport = vi.fn<typeof fetch>();
  const adapter = new MeilisearchIndexAdapter({
    baseUrl: 'http://127.0.0.1:7700/meili',
    apiKey: 'test-engine-credential',
    fetch: transport,
  });
  return { adapter, transport };
}

function result(hits: readonly unknown[]): Response {
  return Response.json({ offset: 0, limit: 2, processingTimeMs: 1, hits });
}

const requestBody = z.object({
  q: z.literal(''),
  offset: z.literal(0),
  limit: z.literal(2),
  filter: z.array(z.string()),
  sort: z.array(z.string()),
  attributesToRetrieve: z.array(z.string()),
});

describe('Meilisearch indexed parent descendants', () => {
  it('returns only locators for the tenant and list and resumes with a parent-bound keyset', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(result([task('CAD-1'), task('CAD-2')]))
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(result([task('CAD-2')]))
      .mockResolvedValueOnce(Response.json(index));

    const first = await adapter.readDescendants(listScope);
    const cursor = z.string().parse(first.nextCursor);
    expect(first.items).toEqual([{ organizationId, kind: 'task', sourceId: 'CAD-1' }]);
    await expect(adapter.readDescendants({ ...listScope, cursor })).resolves.toEqual({
      items: [{ organizationId, kind: 'task', sourceId: 'CAD-2' }],
      nextCursor: null,
    });
    const firstBody = requestBody.parse(
      JSON.parse(z.string().parse(transport.mock.calls[1]?.[1]?.body)),
    );
    const afterBody = requestBody.parse(
      JSON.parse(z.string().parse(transport.mock.calls[4]?.[1]?.body)),
    );
    expect(firstBody.filter).toEqual([
      `organizationId = "${organizationId}"`,
      'kind = "task"',
      `listId = "${listId}"`,
    ]);
    expect(afterBody.filter.slice(0, -1)).toEqual(firstBody.filter);
    expect(afterBody.filter.at(-1)).toMatch(/^\(\(kindRank > 0\) OR /u);
    expect(firstBody.attributesToRetrieve).toEqual([
      'projectionId',
      'organizationId',
      'kind',
      'sourceId',
      'kindRank',
      'orderHigh',
      'orderMiddle',
      'orderLow',
      'listId',
      'spaceId',
    ]);

    await expect(
      adapter.readDescendants({
        ...listScope,
        cursor,
        parent: { ...listScope.parent, sourceId: otherId },
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      adapter.readDescendants({
        ...listScope,
        cursor,
        generation: { ...generation, engineCreatedAt: '2026-11-21T00:48:12.123457Z' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      adapter.readDescendants({ ...listScope, cursor: `${cursor}=` }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it('accepts tasks and lists in the same space while rejecting a descendant lookahead in a different space', async () => {
    const { adapter, transport } = setup();
    const input = {
      ...listScope,
      parent: { organizationId, kind: 'space' as const, sourceId: spaceId },
    };
    transport
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(result([list(listId)]))
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(result([task('CAD-1'), { ...list(listId), spaceId: otherId }]));
    await expect(adapter.readDescendants(input)).resolves.toEqual({
      items: [{ organizationId, kind: 'list', sourceId: listId }],
      nextCursor: null,
    });
    await expect(adapter.readDescendants(input)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    const body = requestBody.parse(
      JSON.parse(z.string().parse(transport.mock.calls[1]?.[1]?.body)),
    );
    expect(body.filter).toEqual([
      `organizationId = "${organizationId}"`,
      'kind IN ["task","list"]',
      `spaceId = "${spaceId}"`,
    ]);
  });

  it('refuses a search result if the expected physical generation changed during the read', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(result([task('CAD-1')]))
      .mockResolvedValueOnce(Response.json({ ...index, createdAt: '2026-11-21T00:48:12.123457Z' }));
    await expect(adapter.readDescendants(listScope)).rejects.toMatchObject({
      code: 'index-replaced',
    });
  });
});
