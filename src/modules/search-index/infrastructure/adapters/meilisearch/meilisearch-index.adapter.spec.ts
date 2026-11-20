import { describe, expect, it, vi } from 'vitest';

import { MeilisearchIndexAdapter } from './meilisearch-index.adapter.js';
import type { MeilisearchIndexDocument } from './meilisearch-index-document.js';

const indexUid = 'search_generation_1';
const organizationId = '01900000-0000-7000-8000-000000000001';
const otherOrganizationId = '01900000-0000-7000-8000-000000000002';
const baseUrl = 'http://127.0.0.1:7700/meili-proxy';
const task: MeilisearchIndexDocument = {
  organizationId,
  kind: 'task',
  sourceId: 'CAD-482',
  title: 'Sprint 14',
  version: 1,
};
const engineIndex = {
  uid: indexUid,
  primaryKey: 'projectionId',
  createdAt: '2026-11-20T19:23:41.749012Z',
};

function setup(options: { readonly pollIntervalMs?: number; readonly timeoutMs?: number } = {}) {
  const transport = vi.fn<typeof fetch>();
  const adapter = new MeilisearchIndexAdapter({
    baseUrl,
    apiKey: 'test-engine-credential',
    pollIntervalMs: 1,
    fetch: transport,
    ...options,
  });
  return { adapter, transport };
}

function queued(uid: number, type: string): Response {
  return Response.json({ taskUid: uid, indexUid, status: 'enqueued', type }, { status: 202 });
}

function result(
  uid: number,
  type: string,
  status = 'succeeded',
  error: { readonly code: string; readonly message?: string } | null = null,
): Response {
  return Response.json({ uid, indexUid, status, type, error });
}

function jsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(init.body) as unknown;
}

describe('MeilisearchIndexAdapter', () => {
  it('checks engine health and a bounded authenticated index read at the configured proxy path', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json({ status: 'available' }))
      .mockResolvedValueOnce(Response.json({ results: [], limit: 1, offset: 0, total: 0 }));

    await adapter.checkHealth();

    expect(transport).toHaveBeenCalledTimes(2);
    const request = transport.mock.calls[0];
    expect(request?.[0]).toEqual(new URL(`${baseUrl}/health`));
    expect(request?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    expect(new Headers(request?.[1]?.headers).has('authorization')).toBe(false);
    const indexRead = transport.mock.calls[1];
    expect(indexRead?.[0]).toEqual(new URL(`${baseUrl}/indexes?limit=1`));
    expect(indexRead?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer test-engine-credential' },
    });
    expect(indexRead?.[1]?.signal).toBe(request?.[1]?.signal);
  });

  it('reports unavailable when the public health check passes but the configured key is refused', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json({ status: 'available' }))
      .mockResolvedValueOnce(
        Response.json({ message: 'Unsafe credential diagnostic' }, { status: 403 }),
      );

    await expect(adapter.checkHealth()).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Meilisearch indexing failed (unavailable).',
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('rejects an inconsistent authenticated index page', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json({ status: 'available' }))
      .mockResolvedValueOnce(Response.json({ results: [], limit: 1, offset: 0, total: 1 }));

    await expect(adapter.checkHealth()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('waits for index creation and then for settings before a generation is ready', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(queued(1, 'indexCreation'))
      .mockResolvedValueOnce(result(1, 'indexCreation', 'processing'))
      .mockResolvedValueOnce(result(1, 'indexCreation'))
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(queued(2, 'settingsUpdate'))
      .mockResolvedValueOnce(result(2, 'settingsUpdate'))
      .mockResolvedValueOnce(Response.json(engineIndex));

    await adapter.createGeneration(indexUid);

    expect(transport.mock.calls.map(([url]) => url)).toEqual(
      [
        'indexes',
        'tasks/1',
        'tasks/1',
        `indexes/${indexUid}`,
        `indexes/${indexUid}/settings`,
        'tasks/2',
        `indexes/${indexUid}`,
      ].map((path) => new URL(`${baseUrl}/${path}`)),
    );
    const request = transport.mock.calls[0];
    expect(request?.[1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-engine-credential' },
      body: JSON.stringify({ uid: indexUid, primaryKey: 'projectionId' }),
      redirect: 'error',
    });
    const settings = transport.mock.calls[4]?.[1];
    expect(settings?.method).toBe('PATCH');
    expect(jsonBody(settings)).toMatchObject({
      filterableAttributes: ['organizationId'],
      searchableAttributes: ['title', 'sourceId', 'taskKey', 'text'],
      displayedAttributes: [
        'projectionId',
        'organizationId',
        'kind',
        'sourceId',
        'version',
        'title',
        'listId',
        'spaceId',
        'taskKey',
      ],
    });
    expect(transport.mock.calls.every(([, init]) => init?.signal === request?.[1]?.signal)).toBe(
      true,
    );
  });

  it('recovers a retry after creation when the existing index has the expected primary key', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(queued(1, 'indexCreation'))
      .mockResolvedValueOnce(result(1, 'indexCreation', 'failed', { code: 'index_already_exists' }))
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(queued(2, 'settingsUpdate'))
      .mockResolvedValueOnce(result(2, 'settingsUpdate'))
      .mockResolvedValueOnce(Response.json(engineIndex));

    await adapter.createGeneration(indexUid);

    expect(transport.mock.calls[2]?.[0]).toEqual(new URL(`${baseUrl}/indexes/${indexUid}`));
    expect(transport.mock.calls[3]?.[1]?.method).toBe('PATCH');
  });

  it('replaces full projections and deletes only keys scoped to the caller organization', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(queued(1, 'documentAdditionOrUpdate'))
      .mockResolvedValueOnce(result(1, 'documentAdditionOrUpdate'))
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(queued(2, 'documentDeletion'))
      .mockResolvedValueOnce(result(2, 'documentDeletion'))
      .mockResolvedValueOnce(Response.json(engineIndex));

    await adapter.upsertDocuments(indexUid, organizationId, [task]);
    await adapter.deleteDocuments(indexUid, otherOrganizationId, [
      { kind: 'task', sourceId: 'CAD-482' },
    ]);

    const upsert = transport.mock.calls[1];
    expect(upsert?.[0]).toEqual(new URL(`${baseUrl}/indexes/${indexUid}/documents`));
    expect(upsert?.[1]?.method).toBe('POST');
    expect(jsonBody(upsert?.[1])).toEqual([
      { ...task, projectionId: `${organizationId}_task_CAD-482` },
    ]);
    const deletion = transport.mock.calls[5];
    expect(deletion?.[0]).toEqual(new URL(`${baseUrl}/indexes/${indexUid}/documents/delete-batch`));
    expect(deletion?.[1]?.body).toBe(JSON.stringify([`${otherOrganizationId}_task_CAD-482`]));
  });

  it('stops before an upsert can recreate an already missing generation', async () => {
    const { adapter, transport } = setup();
    transport.mockResolvedValueOnce(Response.json({ code: 'index_not_found' }, { status: 404 }));

    await expect(adapter.upsertDocuments(indexUid, organizationId, [task])).rejects.toMatchObject({
      code: 'index-not-found',
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('refuses to confirm a successful task after an index with the same name was recreated', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(Response.json(engineIndex))
      .mockResolvedValueOnce(queued(1, 'documentAdditionOrUpdate'))
      .mockResolvedValueOnce(result(1, 'documentAdditionOrUpdate'))
      .mockResolvedValueOnce(
        Response.json({ ...engineIndex, createdAt: '2026-11-20T19:23:41.749013Z' }),
      );

    await expect(adapter.upsertDocuments(indexUid, organizationId, [task])).rejects.toMatchObject({
      code: 'index-replaced',
    });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('rejects mixed tenants, duplicate keys, count and byte overflow before contacting the engine', async () => {
    const { adapter, transport } = setup();
    await expect(
      adapter.upsertDocuments(indexUid, organizationId, [
        { ...task, organizationId: otherOrganizationId },
      ]),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      adapter.upsertDocuments(indexUid, organizationId, [task, task]),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      adapter.deleteDocuments(
        indexUid,
        organizationId,
        Array.from({ length: 101 }, (_, i) => ({ kind: 'task', sourceId: `CAD-${String(i)}` })),
      ),
    ).rejects.toMatchObject({ code: 'batch-too-large' });
    const largeText = '🔎'.repeat(100_000);
    await expect(
      adapter.upsertDocuments(
        indexUid,
        organizationId,
        Array.from({ length: 3 }, (_, i) => ({
          ...task,
          sourceId: `CAD-${String(i)}`,
          text: largeText,
        })),
      ),
    ).rejects.toMatchObject({ code: 'batch-too-large' });
    await expect(adapter.createGeneration('../tasks')).rejects.toMatchObject({
      code: 'invalid-request',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns task failure codes without retaining the engine message', async () => {
    const { adapter, transport } = setup();
    transport.mockResolvedValueOnce(queued(1, 'indexCreation')).mockResolvedValueOnce(
      result(1, 'indexCreation', 'failed', {
        code: 'invalid_document',
        message: 'Unsafe upstream data',
      }),
    );

    await expect(adapter.createGeneration(indexUid)).rejects.toMatchObject({
      code: 'task-failed',
      message: 'Meilisearch indexing failed (task-failed).',
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched task, an oversized response and a redirect', async () => {
    const { adapter, transport } = setup();
    transport
      .mockResolvedValueOnce(queued(1, 'indexCreation'))
      .mockResolvedValueOnce(result(2, 'indexCreation'))
      .mockResolvedValueOnce(Response.json({ status: 'available', padding: 'a'.repeat(65_536) }))
      .mockResolvedValueOnce(Response.redirect('https://example.invalid/health'));

    await expect(adapter.createGeneration(indexUid)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    await expect(adapter.checkHealth()).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(adapter.checkHealth()).rejects.toMatchObject({ code: 'unavailable' });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(transport.mock.calls[3]?.[1]?.redirect).toBe('error');
  });

  it('bounds all polls with the operation deadline and respects caller cancellation', async () => {
    const { adapter, transport } = setup({ timeoutMs: 200, pollIntervalMs: 1_000 });
    transport
      .mockResolvedValueOnce(queued(1, 'indexCreation'))
      .mockResolvedValueOnce(result(1, 'indexCreation', 'processing'));
    await expect(adapter.createGeneration(indexUid)).rejects.toMatchObject({ code: 'timeout' });
    expect(transport).toHaveBeenCalledTimes(2);

    const caller = new AbortController();
    caller.abort(new Error('Caller data'));
    await expect(adapter.checkHealth(caller.signal)).rejects.toMatchObject({
      code: 'aborted',
      message: 'Meilisearch indexing failed (aborted).',
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
