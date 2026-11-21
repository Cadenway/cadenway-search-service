import { generateKeyPairSync } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

import {
  InternalHttpClient,
  InternalTokenSigner,
  InternalTokenVerifier,
  ProblemException,
  runWithDeadline,
} from '@cadenway/nest-common';
import type { Ed25519PublicJwk, InternalRequestInit } from '@cadenway/nest-common';
import { describe, expect, it, vi } from 'vitest';

import { DocumentSearchAuthorityAdapter } from './document-search-authority.adapter.js';
import { OrganizationSearchAuthorityAdapter } from './organization-search-authority.adapter.js';
import { StorageSearchAuthorityAdapter } from './storage-search-authority.adapter.js';
import { TaskSearchAuthorityAdapter } from './task-search-authority.adapter.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const userId = '019a5f3c-9e1f-7b2a-8c3d-4e5f6a7b8c31';
const listId = '019a7001-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const spaceId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const otherSpaceId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const documentId = '019a7005-4b2c-7d4e-8f5a-6b7c8d9e0f17';
const fileId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const otherFileId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16';
const membership = {
  memberId: '019a5f3d-1a2b-7c3d-8e4f-5a6b7c8d9e41',
  version: 2,
  role: 'admin',
} as const;
const task = {
  kind: 'task',
  id: 'CAD-482',
  version: 12,
  name: 'Refondre l’écran de connexion SSO',
  lifecycle: 'active',
  status: 'progress',
  listId,
  spaceId,
} as const;
const document = {
  documentId,
  spaceId,
  version: 3,
  title: 'Notes de version 3.1',
  body: '## Nouveautés',
};
const attachment = { fileId, taskKey: 'CAD-482', fileName: 'maquette-sso.png', version: 1 };
const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'application/json',
};

function json(data: unknown): Response {
  return Response.json(data, { headers: responseHeaders });
}

describe('Search authority HTTP adapters', () => {
  it('signs all nine calls for their owner and never forwards authority from the request payload', async () => {
    const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    if (x === undefined || d === undefined)
      throw new Error('Missing synthetic Ed25519 key material.');
    const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', kid: 'search-test', x };
    const signer = await InternalTokenSigner.create({
      issuer: 'search-service',
      privateJwk: { ...publicJwk, d },
    });

    async function owner(
      service: string,
      responses: Readonly<Record<string, unknown>>,
    ): Promise<InternalHttpClient> {
      const verifier = await InternalTokenVerifier.create({
        audience: service,
        trustedIssuers: { 'search-service': [publicJwk] },
      });
      return new InternalHttpClient({
        service,
        baseUrl: `http://${service}:3019`,
        signer,
        fetch: async (target, init) => {
          const url = new URL(target instanceof Request ? target.url : target);
          expect(url.hostname).toBe(service);
          expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
          const authorization = new Headers(init?.headers).get('authorization') ?? '';
          const principal = await verifier.verify(authorization.slice('Bearer '.length));
          const isRoster = url.pathname === '/internal/v1/search-organizations';
          const isDelegated =
            url.pathname === '/internal/v1/search-membership' ||
            url.pathname === '/internal/v1/task-search-access/resolve';
          expect(principal).toMatchObject({
            actor: isDelegated
              ? { type: 'user', id: userId }
              : { type: 'system', id: 'search-service' },
            issuer: 'search-service',
            audience: service,
            organizationId: isRoster ? null : organizationId,
            role: null,
            scopes: [],
          });
          expect(url.searchParams.has('organizationId')).toBe(false);
          if (url.pathname === '/internal/v1/task-search-projections') {
            expect(url.searchParams.get('cursor')).toBe('x=y/z+');
          }
          if (init?.method === 'POST') {
            if (typeof init.body !== 'string') throw new Error('Search request body was missing.');
            const body: unknown = JSON.parse(init.body);
            expect(body).not.toHaveProperty('organizationId');
            expect(body).not.toHaveProperty('userId');
          }
          if (!Object.hasOwn(responses, url.pathname))
            throw new Error('Unexpected authority route.');
          return json(responses[url.pathname]);
        },
      });
    }

    const organizationAdapter = new OrganizationSearchAuthorityAdapter(
      await owner('organization-service', {
        '/internal/v1/search-organizations': { items: [organizationId], nextCursor: null },
        '/internal/v1/search-membership': membership,
      }),
    );
    const taskAdapter = new TaskSearchAuthorityAdapter(
      await owner('task-service', {
        '/internal/v1/task-search-projections': { items: [task], nextCursor: 'safe cursor +' },
        '/internal/v1/task-search-projections/resolve': {
          results: [{ status: 'present', projection: task }],
        },
        '/internal/v1/task-search-access/resolve': {
          results: [{ kind: 'space', id: spaceId, version: 1, directSpace: false }],
        },
      }),
    );
    const documentAdapter = new DocumentSearchAuthorityAdapter(
      await owner('document-service', {
        '/internal/v1/document-search-projections': { items: [document], nextCursor: null },
        '/internal/v1/document-search-projections/resolve': {
          results: [{ status: 'present', projection: document }],
        },
      }),
    );
    const storageAdapter = new StorageSearchAuthorityAdapter(
      await owner('storage-service', {
        '/internal/v1/attachment-search-projections': { items: [attachment], nextCursor: null },
        '/internal/v1/attachment-search-projections/resolve': {
          results: [
            { status: 'present', projection: attachment },
            { status: 'absent', fileId: otherFileId, version: 2 },
          ],
        },
      }),
    );

    await expect(organizationAdapter.listOrganizations({ limit: 1 })).resolves.toMatchObject({
      items: [organizationId],
    });
    await expect(organizationAdapter.getMembership(organizationId, userId)).resolves.toEqual(
      membership,
    );
    await expect(
      taskAdapter.listTaskProjections(organizationId, {
        kind: 'task',
        listId,
        spaceId,
        cursor: 'x=y/z+',
      }),
    ).resolves.toMatchObject({ items: [task], nextCursor: 'safe cursor +' });
    await expect(
      taskAdapter.resolveTaskProjections(organizationId, { kind: 'task', ids: ['CAD-482'] }),
    ).resolves.toEqual({ results: [{ status: 'present', projection: task }] });
    await expect(
      taskAdapter.resolveAccess(organizationId, userId, {
        membership,
        candidates: [
          { kind: 'task', id: 'CAD-482' },
          { kind: 'space', id: spaceId.toUpperCase() },
        ],
      }),
    ).resolves.toEqual({
      results: [{ kind: 'space', id: spaceId, version: 1, directSpace: false }],
    });
    await expect(documentAdapter.listDocuments(organizationId, {})).resolves.toEqual({
      items: [document],
      nextCursor: null,
    });
    await expect(
      documentAdapter.resolveDocuments(organizationId, { documentIds: [documentId] }),
    ).resolves.toEqual({ results: [{ status: 'present', projection: document }] });
    await expect(storageAdapter.listAttachments(organizationId, {})).resolves.toEqual({
      items: [attachment],
      nextCursor: null,
    });
    await expect(
      storageAdapter.resolveAttachments(organizationId, {
        fileIds: [fileId.toUpperCase(), otherFileId],
      }),
    ).resolves.toEqual({
      results: [
        { status: 'present', projection: attachment },
        { status: 'absent', fileId: otherFileId, version: 2 },
      ],
    });
  });

  it('reports membership absence only for the exact Organization not-found problem', async () => {
    const fetch = vi.fn<(path: string, request?: InternalRequestInit) => Promise<Response>>();
    const client = new OrganizationSearchAuthorityAdapter({ fetch });
    fetch.mockRejectedValueOnce(
      new ProblemException({ status: 404, code: 'organization.not-found' }),
    );
    fetch.mockRejectedValueOnce(
      new ProblemException({ status: 404, code: 'upstream.error', detail: 'private detail' }),
    );
    fetch.mockResolvedValueOnce(json(null));
    await expect(client.getMembership(organizationId, userId)).resolves.toBeNull();
    await expect(client.getMembership(organizationId, userId)).rejects.toMatchObject({
      reason: 'unavailable',
      message: 'Search authority call failed: unavailable',
    });
    await expect(client.getMembership(organizationId, userId)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('preserves the specified batch split and stale-cursor outcomes without forwarding upstream errors', async () => {
    const fetch = vi.fn<(path: string, request?: InternalRequestInit) => Promise<Response>>();
    const client = new DocumentSearchAuthorityAdapter({ fetch });
    fetch.mockRejectedValueOnce(
      new ProblemException({ status: 422, code: 'document.projection-batch-too-large' }),
    );
    fetch.mockRejectedValueOnce(
      new ProblemException({ status: 422, code: 'document.limit', detail: 'private detail' }),
    );
    fetch.mockRejectedValueOnce(new ProblemException({ status: 400, code: 'request.invalid' }));
    await expect(
      client.resolveDocuments(organizationId, { documentIds: [documentId] }),
    ).rejects.toMatchObject({ reason: 'batch-too-large' });
    await expect(
      client.resolveDocuments(organizationId, { documentIds: [documentId] }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(client.listDocuments(organizationId, { cursor: 'expired' })).rejects.toMatchObject(
      { reason: 'invalid-request' },
    );
  });

  it.each([
    ['exceeds the requested size', { items: [organizationId, userId], nextCursor: null }],
    ['repeats a cursor', { items: [organizationId], nextCursor: 'current' }],
    ['does not advance past an item', { items: [], nextCursor: 'new' }],
    ['changes the wire shape', { items: [organizationId], unexpected: true, nextCursor: null }],
  ])('rejects a roster page that %s', async (_case, page) => {
    const client = new OrganizationSearchAuthorityAdapter({
      fetch: () => Promise.resolve(json(page)),
    });
    await expect(client.listOrganizations({ cursor: 'current', limit: 1 })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('rejects a Task projection that belongs to a different parent filter', async () => {
    const client = new TaskSearchAuthorityAdapter({
      fetch: () => Promise.resolve(json({ items: [task], nextCursor: null })),
    });
    await expect(
      client.listTaskProjections(organizationId, { kind: 'task', spaceId: otherSpaceId }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it.each([
    ['missing decision', []],
    [
      'swapped decision',
      [
        { status: 'absent', fileId: otherFileId, version: null },
        { status: 'present', projection: attachment },
      ],
    ],
    [
      'extra projection field',
      [{ status: 'present', projection: { ...attachment, objectKey: 'private-object' } }],
    ],
  ])('rejects Storage resolution with a %s', async (_case, results) => {
    const client = new StorageSearchAuthorityAdapter({
      fetch: () => Promise.resolve(json({ results })),
    });
    const fileIds = _case === 'swapped decision' ? [fileId, otherFileId] : [fileId];
    await expect(client.resolveAttachments(organizationId, { fileIds })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('rejects a duplicate live proof or a proof for an unrequested selector', async () => {
    const fetch = vi.fn<(path: string, request?: InternalRequestInit) => Promise<Response>>();
    const client = new TaskSearchAuthorityAdapter({ fetch });
    const space = { kind: 'space', id: spaceId, version: 1, directSpace: true };
    fetch.mockResolvedValueOnce(json({ results: [space, space] }));
    fetch.mockResolvedValueOnce(json({ results: [{ ...space, id: otherSpaceId }] }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        client.resolveAccess(organizationId, userId, {
          membership,
          candidates: [{ kind: 'space', id: spaceId }],
        }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
    }
  });

  it('refuses duplicate UUIDs before calling the producer', async () => {
    const fetch = vi.fn<(path: string, request?: InternalRequestInit) => Promise<Response>>();
    const client = new StorageSearchAuthorityAdapter({ fetch });
    await expect(
      client.resolveAttachments(organizationId, { fileIds: [fileId, fileId.toUpperCase()] }),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a complete private JSON 200 from the owner', async () => {
    const fetch = vi.fn<(path: string, request?: InternalRequestInit) => Promise<Response>>();
    fetch.mockResolvedValueOnce(Response.json(membership));
    fetch.mockResolvedValueOnce(
      Response.json(membership, { status: 206, headers: responseHeaders }),
    );
    const client = new OrganizationSearchAuthorityAdapter({ fetch });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(client.getMembership(organizationId, userId)).rejects.toMatchObject({
        reason: 'unavailable',
      });
    }
  });

  it('stops a streaming response after its UTF-8 byte limit without waiting for a closing frame', async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode('🙂'.repeat(270_000));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel,
    });
    const client = new DocumentSearchAuthorityAdapter({
      fetch: () => Promise.resolve(new Response(body, { headers: responseHeaders })),
    });
    await expect(client.listDocuments(organizationId, {})).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a response body when the user abandons an in-flight call', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const client = new OrganizationSearchAuthorityAdapter({
      fetch: () => Promise.resolve(new Response(body, { headers: responseHeaders })),
    });
    const request = client.getMembership(organizationId, userId, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toMatchObject({ reason: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('enforces the inherited request deadline after headers arrive', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const client = new OrganizationSearchAuthorityAdapter({
      fetch: () => Promise.resolve(new Response(body, { headers: responseHeaders })),
    });
    const request = runWithDeadline(100, () => client.getMembership(organizationId, userId));
    // Keep the event loop live while the request's AbortSignal timer expires.
    const keepAlive = new AbortController();
    const timer = setTimeout(1000, undefined, { signal: keepAlive.signal }).catch(() => undefined);
    try {
      await expect(request).rejects.toMatchObject({ reason: 'unavailable' });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      keepAlive.abort();
      await timer;
    }
  });
});
