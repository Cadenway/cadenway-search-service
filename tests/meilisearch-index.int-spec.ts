import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { MeilisearchIndexAdapter } from '../src/modules/search-index/infrastructure/adapters/meilisearch/meilisearch-index.adapter.js';

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
  async function search(organizationId: string, q: string): Promise<readonly string[]> {
    const result = await fetchFixture(`/indexes/${indexUid}/search`, {
      method: 'POST',
      body: JSON.stringify({ q, filter: `organizationId = "${organizationId}"` }),
    });
    expect(result.status).toBe(200);
    return searchResult.parse(await result.json()).hits.map((hit) => hit.title);
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
    await adapter.createGeneration(indexUid);
    const document = {
      kind: 'document' as const,
      sourceId,
      organizationId: atelierNordId,
      version: 1,
      title: 'Review',
      text: 'obsoletefixture',
    };
    await adapter.upsertDocuments(indexUid, atelierNordId, [document]);
    await adapter.upsertDocuments(indexUid, anotherOrganizationId, [
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
    await adapter.upsertDocuments(indexUid, atelierNordId, [replacement]);
    expect(await search(atelierNordId, 'obsoletefixture')).toEqual([]);
    expect(await search(atelierNordId, 'Revision')).toEqual(['Revision']);

    await adapter.deleteDocuments(indexUid, atelierNordId, [{ kind: 'document', sourceId }]);
    expect(await search(atelierNordId, '')).toEqual([]);
    expect(await search(anotherOrganizationId, '')).toEqual(['Other review']);
  });

  it('fails when a generation disappears before an upsert', async () => {
    const temporaryIndex = 'fixture-disappearing';
    await adapter.createGeneration(temporaryIndex);
    const deletion = await fetchFixture(`/indexes/${temporaryIndex}`, { method: 'DELETE' });
    expect(deletion.status).toBe(202);
    await deletion.body?.cancel();
    await vi.waitFor(async () => {
      const current = await fetchFixture(`/indexes/${temporaryIndex}`);
      await current.body?.cancel();
      expect(current.status).toBe(404);
    });

    await expect(
      adapter.upsertDocuments(temporaryIndex, atelierNordId, [
        { organizationId: atelierNordId, kind: 'document', sourceId, title: 'Missing', version: 1 },
      ]),
    ).rejects.toThrow();
    const missing = await fetchFixture(`/indexes/${temporaryIndex}`);
    await missing.body?.cancel();
    expect(missing.status).toBe(404);
  });
});
