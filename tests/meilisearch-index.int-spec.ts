import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { literalSearchProbeTerms } from '../src/modules/search-index/domain/policies/literal-search/literal-search.policy.js';
import { MeilisearchIndexAdapter } from '../src/modules/search-index/infrastructure/adapters/meilisearch/meilisearch-index.adapter.js';
import { MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS } from '../src/modules/search-index/infrastructure/adapters/meilisearch/meilisearch-literal-search-sort-fields.js';

const composeFile = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));
const project = `cadenway-search-meili-test-${String(process.pid)}`;
const fixtureKey = 'local-development-master-key';
const indexUid = 'fixture-generation';
const atelierNordId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const anotherOrganizationId = '01938f6e-0000-7000-8000-000000000002';
const sourceId = '01938f6e-0000-7000-8000-000000000001';
const searchResult = z.object({ hits: z.array(z.object({ title: z.string() })) });

/** Runs the checked-in dependencies in a fixture-specific Compose project. */
function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '-f', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_MEILI_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    },
  );
}

describe('Meilisearch index generations', () => {
  let baseUrl: string;
  let adapter: MeilisearchIndexAdapter;

  /** Calls only the disposable index to inspect actual engine state. */
  function fetchFixture(path: string, init?: RequestInit): Promise<Response> {
    return fetch(new URL(path, baseUrl), {
      ...init,
      headers: { Authorization: `Bearer ${fixtureKey}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  }

  /** Searches a fixture organization using the property created by generation setup. */
  async function search(
    organizationId: string,
    q: string,
    uid = indexUid,
  ): Promise<readonly string[]> {
    const result = await fetchFixture(`/indexes/${uid}/search`, {
      method: 'POST',
      body: JSON.stringify({ q, filter: `organizationId = "${organizationId}"` }),
    });
    expect(result.status).toBe(200);
    return searchResult.parse(await result.json()).hits.map((hit) => hit.title);
  }

  /** Waits for an index deletion issued directly to the disposable engine. */
  async function deleteFixtureIndex(uid: string): Promise<void> {
    const deletion = await fetchFixture(`/indexes/${uid}`, { method: 'DELETE' });
    expect(deletion.status).toBe(202);
    await deletion.body?.cancel();
    await vi.waitFor(
      async () => {
        const current = await fetchFixture(`/indexes/${uid}`);
        await current.body?.cancel();
        expect(current.status).toBe(404);
      },
      { timeout: 5_000 },
    );
  }

  beforeAll(() => {
    compose('up', '--detach', '--wait', '--wait-timeout', '120', '--no-deps', 'meilisearch');
    const port = compose('port', 'meilisearch', '7700').trim().split(':').at(-1);
    if (port === undefined || !/^[1-9]\d*$/u.test(port))
      throw new Error('The Meilisearch fixture has no published port.');
    baseUrl = `http://127.0.0.1:${port}`;
    adapter = new MeilisearchIndexAdapter({ baseUrl, apiKey: fixtureKey, timeoutMs: 15_000 });
  });

  afterAll(() => {
    compose('down', '--volumes', '--remove-orphans');
  });

  it('refuses readiness when the configured key cannot read index metadata', async () => {
    const unauthorized = new MeilisearchIndexAdapter({
      baseUrl,
      apiKey: 'wrong-synthetic-fixture-key',
    });
    await expect(unauthorized.checkHealth()).rejects.toThrow();
    await expect(adapter.checkHealth()).resolves.toBeUndefined();
  });

  it('waits for settings and keeps replacement and deletion scoped to the tenant key', async () => {
    await adapter.checkHealth();
    const createdAt = await adapter.createGeneration(indexUid);
    await expect(adapter.readGenerationIdentity(indexUid)).resolves.toBe(createdAt);
    const document = {
      kind: 'document' as const,
      sourceId,
      organizationId: atelierNordId,
      version: 1,
      title: 'Review',
      text: 'obsoletefixture',
    };
    await adapter.upsertDocuments(indexUid, createdAt, atelierNordId, [document]);
    await adapter.upsertDocuments(indexUid, createdAt, anotherOrganizationId, [
      { ...document, organizationId: anotherOrganizationId, title: 'Other review' },
    ]);

    expect(await search(atelierNordId, 'obsoletefixture')).toEqual(['Review']);
    expect(await search(anotherOrganizationId, '')).toEqual(['Other review']);
    const replacement = {
      organizationId: atelierNordId,
      kind: 'document' as const,
      sourceId,
      title: 'Revision',
      version: 2,
    };
    await adapter.upsertDocuments(indexUid, createdAt, atelierNordId, [replacement]);
    expect(await search(atelierNordId, 'obsoletefixture')).toEqual([]);
    expect(await search(atelierNordId, 'Revision')).toEqual(['Revision']);

    await adapter.deleteDocuments(indexUid, createdAt, atelierNordId, [
      { kind: 'document', sourceId },
    ]);
    expect(await search(atelierNordId, '')).toEqual([]);
    expect(await search(anotherOrganizationId, '')).toEqual(['Other review']);
  });

  it('fails when a generation disappears before an upsert', async () => {
    const temporaryIndex = 'fixture-disappearing';
    const oldIdentity = await adapter.createGeneration(temporaryIndex);
    await deleteFixtureIndex(temporaryIndex);

    await expect(
      adapter.upsertDocuments(temporaryIndex, oldIdentity, atelierNordId, [
        { organizationId: atelierNordId, kind: 'document', sourceId, title: 'Missing', version: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'index-not-found' });
    const missing = await fetchFixture(`/indexes/${temporaryIndex}`);
    await missing.body?.cancel();
    expect(missing.status).toBe(404);
  });

  it('refuses to overwrite or delete documents after another instance recreates the same index UID', async () => {
    const uid = 'fixture-replaced';
    const oldIdentity = await adapter.createGeneration(uid);
    await deleteFixtureIndex(uid);

    const replica = new MeilisearchIndexAdapter({ baseUrl, apiKey: fixtureKey, timeoutMs: 15_000 });
    const replacementIdentity = await replica.createGeneration(uid);
    expect(replacementIdentity).not.toBe(oldIdentity);
    await expect(adapter.createGeneration(uid)).rejects.toMatchObject({
      code: 'index-already-exists',
    });

    const document = {
      organizationId: atelierNordId,
      kind: 'document' as const,
      sourceId,
      title: 'Current',
      version: 2,
    };
    await replica.upsertDocuments(uid, replacementIdentity, atelierNordId, [document]);
    await expect(
      adapter.upsertDocuments(uid, oldIdentity, atelierNordId, [{ ...document, title: 'Stale' }]),
    ).rejects.toMatchObject({ code: 'index-replaced' });
    await expect(
      adapter.deleteDocuments(uid, oldIdentity, atelierNordId, [{ kind: 'document', sourceId }]),
    ).rejects.toMatchObject({ code: 'index-replaced' });
    await expect(adapter.readGenerationIdentity(uid)).resolves.toBe(replacementIdentity);
    expect(await search(atelierNordId, '', uid)).toEqual(['Current']);
  });

  it('filters literal terms, preserves task status and sorts palette candidates by numeric keys', async () => {
    const uid = 'fixture-palette';
    const createdAt = await adapter.createGeneration(uid);
    const item = { organizationId: atelierNordId, title: 'Connexion SSO', version: 1 };
    await adapter.upsertDocuments(uid, createdAt, atelierNordId, [
      { ...item, kind: 'list', sourceId },
      { ...item, kind: 'task', sourceId: 'CAD-120', status: 'blocked' },
      { ...item, kind: 'document', sourceId },
      { ...item, kind: 'task', sourceId: 'CAD-12', status: 'progress' },
    ]);

    const result = await fetchFixture(`/indexes/${uid}/search`, {
      method: 'POST',
      body: JSON.stringify({
        q: '',
        filter: [
          `organizationId = "${atelierNordId}"`,
          'kind IN ["task", "list"]',
          ...literalSearchProbeTerms('nexion').map((term) => `literalTerms = "${term}"`),
        ],
        sort: MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS.map((field) => `${field}:asc`),
      }),
    });
    expect(result.status).toBe(200);
    const candidates = z.object({
      hits: z.array(
        z.object({ kind: z.string(), sourceId: z.string(), status: z.string().optional() }),
      ),
    });
    expect(candidates.parse(await result.json()).hits).toEqual([
      { kind: 'task', sourceId: 'CAD-12', status: 'progress' },
      { kind: 'task', sourceId: 'CAD-120', status: 'blocked' },
      { kind: 'list', sourceId },
    ]);
  });

  it('resumes after the thousandth matching candidate with a keyset at offset zero', async () => {
    const uid = 'fixture-palette-window';
    const engineCreatedAt = await adapter.createGeneration(uid);
    const generation = '01938f6e-0000-7000-8000-000000000012';
    const reader = new MeilisearchIndexAdapter({
      baseUrl,
      apiKey: fixtureKey,
      timeoutMs: 15_000,
      findActiveGeneration: () =>
        Promise.resolve({ id: generation, indexUid: uid, engineCreatedAt }),
    });
    const ids = Array.from({ length: 1_005 }, (_, index) => `CAD-${String(index + 1)}`);
    for (let start = 0; start < ids.length; start += 100) {
      await adapter.upsertDocuments(
        uid,
        engineCreatedAt,
        atelierNordId,
        ids.slice(start, start + 100).map((id) => ({
          organizationId: atelierNordId,
          kind: 'task',
          sourceId: id,
          title: 'Sprint 14',
          version: 1,
          status: 'todo',
          listId: sourceId,
          spaceId: sourceId,
        })),
      );
    }
    ids.sort();
    const anchor = ids[999];
    if (anchor === undefined) throw new Error('The fixture has fewer than 1,000 candidates.');

    const page = await reader.read({
      organizationId: atelierNordId,
      normalizedQuery: 'rint 1',
      after: { kind: 'task', id: anchor },
      generation,
      limit: 2,
    });
    expect(page.generation).toBe(generation);
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(1_000, 1_002));
    expect(page.hasMore).toBe(true);
  });

  it('recovers indexed descendants across bounded list and space pages without crossing tenants', async () => {
    const uid = 'fixture-parent-recovery';
    const engineCreatedAt = await adapter.createGeneration(uid);
    const generation = {
      id: '01938f6e-0000-7000-8000-000000000013',
      indexUid: uid,
      engineCreatedAt,
    };
    const listId = sourceId;
    const otherList = '01938f6e-0000-7000-8000-000000000021';
    const spaceId = '01938f6e-0000-7000-8000-000000000022';
    const otherSpace = '01938f6e-0000-7000-8000-000000000023';
    const localTask = {
      organizationId: atelierNordId,
      kind: 'task' as const,
      version: 1,
      title: 'Hidden draft',
      status: 'todo' as const,
      listId,
      spaceId,
    };
    await adapter.upsertDocuments(uid, engineCreatedAt, atelierNordId, [
      { ...localTask, sourceId: 'CAD-501' },
      { ...localTask, sourceId: 'CAD-502' },
      { ...localTask, sourceId: 'CAD-503', listId: otherList },
      { ...localTask, sourceId: 'CAD-504', listId: otherList, spaceId: otherSpace },
      {
        organizationId: atelierNordId,
        kind: 'list',
        sourceId: listId,
        version: 1,
        title: 'Sprint 14',
        spaceId,
      },
      {
        organizationId: atelierNordId,
        kind: 'list',
        sourceId: otherList,
        version: 1,
        title: 'Sprint 15',
        spaceId,
      },
    ]);
    await adapter.upsertDocuments(uid, engineCreatedAt, anotherOrganizationId, [
      { ...localTask, sourceId: 'CAD-500', organizationId: anotherOrganizationId },
    ]);

    const listScope = {
      generation,
      parent: { organizationId: atelierNordId, kind: 'list' as const, sourceId: listId },
      limit: 1,
    };
    const first = await adapter.readDescendants({ ...listScope, cursor: null });
    expect(first.items).toEqual([
      { organizationId: atelierNordId, kind: 'task', sourceId: 'CAD-501' },
    ]);
    const cursor = z.string().parse(first.nextCursor);
    await expect(adapter.readDescendants({ ...listScope, cursor })).resolves.toEqual({
      items: [{ organizationId: atelierNordId, kind: 'task', sourceId: 'CAD-502' }],
      nextCursor: null,
    });

    const space = await adapter.readDescendants({
      generation,
      parent: { organizationId: atelierNordId, kind: 'space', sourceId: spaceId },
      cursor: null,
      limit: 100,
    });
    expect(space.items.map(({ sourceId: id }) => id)).toEqual([
      'CAD-501',
      'CAD-502',
      'CAD-503',
      listId,
      otherList,
    ]);
    expect(space.nextCursor).toBeNull();
  });
});
