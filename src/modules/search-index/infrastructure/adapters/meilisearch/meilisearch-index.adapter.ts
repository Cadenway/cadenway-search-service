import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { MeilisearchIndexError } from './meilisearch-index.error.js';
import type { MeilisearchIndexDocument } from './meilisearch-index-document.js';
import type { MeilisearchProjectionKey } from './meilisearch-projection-key.js';

const primaryKey = 'projectionId';
const maxBatchItems = 100;
const maxBatchBytes = 1_048_576;
const maxResponseBytes = 65_536;
const maxTimerMs = 2_147_483_647;
const indexIdentifier = /^[a-zA-Z0-9_-]{1,128}$/u;
const kind = z.enum(['task', 'list', 'space', 'document', 'attachment']);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const keyFields = { kind, sourceId: z.string().regex(indexIdentifier) };
const projectionKey = z.strictObject(keyFields);
const indexDocument = z.strictObject({
  ...keyFields,
  organizationId: uuid,
  version: z.int().positive(),
  title: z.string().min(1).max(512),
  text: z.string().max(200_000).optional(),
  listId: uuid.optional(),
  spaceId: uuid.optional(),
  taskKey: z.string().regex(indexIdentifier).optional(),
});
const enqueuedTask = z.object({
  taskUid: z.int().nonnegative(),
  indexUid: z.string().nullable(),
  status: z.literal('enqueued'),
  type: z.string(),
});
const taskResult = z.object({
  uid: z.int().nonnegative(),
  indexUid: z.string(),
  status: z.enum(['enqueued', 'processing', 'succeeded', 'failed', 'canceled']),
  type: z.string(),
  error: z.object({ code: z.string() }).nullable(),
});
const indexMetadata = z.object({
  uid: z.string().min(1),
  primaryKey: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
const generationIndex = indexMetadata.extend({ primaryKey: z.literal(primaryKey) });
const indexPage = z.object({
  results: z.array(indexMetadata).max(1),
  limit: z.literal(1),
  offset: z.literal(0),
  total: z.int().nonnegative(),
});
const engineHealth = z.object({ status: z.literal('available') });

interface IndexAdapterOptions {
  // #region Properties
  /** Trusted engine URL, including its proxy path when configured. */
  readonly baseUrl: string;

  /** Key used by index and task endpoints. */
  readonly apiKey: string;

  /** Deadline in milliseconds for an entire operation. */
  readonly timeoutMs?: number;

  /** Time in milliseconds to wait between task polls. */
  readonly pollIntervalMs?: number;

  /** Optional HTTP transport for tests. */
  readonly fetch?: typeof fetch;
  // #endregion
}

type TaskType =
  'indexCreation' | 'settingsUpdate' | 'documentAdditionOrUpdate' | 'documentDeletion';

function organizationKey(organizationId: string): string {
  const result = uuid.safeParse(organizationId);
  if (!result.success) throw new MeilisearchIndexError('invalid-request');
  return result.data;
}

function normalizeSourceId(key: MeilisearchProjectionKey): string {
  if (key.kind === 'task') return key.sourceId;
  const result = uuid.safeParse(key.sourceId);
  if (!result.success) throw new MeilisearchIndexError('invalid-request');
  return result.data;
}

function encodeBatch<T>(
  items: readonly T[],
  project: (item: T) => { readonly id: string; readonly payload: object | string },
): string {
  if (items.length > maxBatchItems) throw new MeilisearchIndexError('batch-too-large');
  const ids = new Set<string>();
  const chunks: string[] = [];
  let size = 2;
  for (const item of items) {
    const { id, payload } = project(item);
    if (ids.has(id)) throw new MeilisearchIndexError('invalid-request');
    const encoded = JSON.stringify(payload);
    size += Buffer.byteLength(encoded, 'utf8') + (chunks.length === 0 ? 0 : 1);
    if (size > maxBatchBytes) throw new MeilisearchIndexError('batch-too-large');
    ids.add(id);
    chunks.push(encoded);
  }
  return `[${chunks.join(',')}]`;
}

/** Writes derived generations and waits for each Meilisearch task to succeed. */
export class MeilisearchIndexAdapter {
  // #region Properties
  /** Validated HTTP base kept private to the transport. */
  private readonly baseUrl: URL;

  /** Credential used only to build the authorization header. */
  readonly #apiKey: string;

  /** Maximum time for all requests and polls in one operation. */
  private readonly timeoutMs: number;

  /** Delay between polls while the engine is still working. */
  private readonly pollIntervalMs: number;

  /** HTTP transport with an injectable fake for focused tests. */
  private readonly fetchRequest: typeof fetch;
  // #endregion

  // #region Constructor
  /** Validates the origin and operation limits without exposing their values. */
  public constructor(options: IndexAdapterOptions) {
    const base = URL.parse(options.baseUrl);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    if (
      base === null ||
      (base.protocol !== 'http:' && base.protocol !== 'https:') ||
      base.username !== '' ||
      base.password !== '' ||
      base.search !== '' ||
      base.hash !== '' ||
      !/^[!-~]+$/u.test(options.apiKey) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > maxTimerMs ||
      !Number.isInteger(pollIntervalMs) ||
      pollIntervalMs < 1 ||
      pollIntervalMs > maxTimerMs
    ) {
      throw new MeilisearchIndexError('invalid-configuration');
    }
    base.pathname = `${base.pathname.replace(/\/+$/u, '')}/`;
    this.baseUrl = base;
    this.#apiKey = options.apiKey;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.fetchRequest = options.fetch ?? fetch;
  }
  // #endregion

  // #region Methods
  /** Checks engine health and index-read access without mutating the engine or testing write permissions. */
  public async checkHealth(signal?: AbortSignal): Promise<void> {
    await this.withDeadline(signal, async (operationSignal) => {
      const result = engineHealth.safeParse(
        await this.requestJson('health', 'GET', 200, operationSignal),
      );
      if (!result.success) throw new MeilisearchIndexError('invalid-response');
      const page = indexPage.safeParse(
        await this.requestJson('indexes?limit=1', 'GET', 200, operationSignal),
      );
      if (!page.success || page.data.results.length !== Math.min(page.data.total, 1)) {
        throw new MeilisearchIndexError('invalid-response');
      }
    });
  }

  /** Prepares a generation, accepting a retry only if the index has the expected primary key. */
  public async createGeneration(indexUid: string, signal?: AbortSignal): Promise<void> {
    const index = this.indexPath(indexUid);
    await this.withDeadline(signal, async (operationSignal) => {
      try {
        await this.submitTask(
          'indexes',
          'POST',
          JSON.stringify({ uid: indexUid, primaryKey }),
          indexUid,
          'indexCreation',
          operationSignal,
        );
      } catch (error: unknown) {
        if (!(error instanceof MeilisearchIndexError) || error.code !== 'index-already-exists') {
          throw error;
        }
      }
      await this.mutateGeneration(index, indexUid, operationSignal, () =>
        this.submitTask(
          `${index}/settings`,
          'PATCH',
          JSON.stringify({
            filterableAttributes: ['organizationId'],
            searchableAttributes: ['title', 'sourceId', 'taskKey', 'text'],
            displayedAttributes: [
              primaryKey,
              'organizationId',
              'kind',
              'sourceId',
              'version',
              'title',
              'listId',
              'spaceId',
              'taskKey',
            ],
          }),
          indexUid,
          'settingsUpdate',
          operationSignal,
        ),
      );
    });
  }

  /** Replaces a tenant batch with whole projections so removed fields do not survive an update. */
  public async upsertDocuments(
    indexUid: string,
    organizationId: string,
    documents: readonly MeilisearchIndexDocument[],
    signal?: AbortSignal,
  ): Promise<void> {
    const index = this.indexPath(indexUid);
    const organization = organizationKey(organizationId);
    if (documents.length === 0) return;
    const body = encodeBatch(documents, (candidate) => {
      const parsed = indexDocument.safeParse(candidate);
      if (!parsed.success || parsed.data.organizationId !== organization) {
        throw new MeilisearchIndexError('invalid-request');
      }
      const document = parsed.data;
      const sourceId = normalizeSourceId(document);
      const id = `${organization}_${document.kind}_${sourceId}`;
      return { id, payload: { ...document, sourceId, [primaryKey]: id } };
    });
    await this.withDeadline(signal, (operationSignal) =>
      this.mutateGeneration(index, indexUid, operationSignal, () =>
        this.submitTask(
          `${index}/documents`,
          'POST',
          body,
          indexUid,
          'documentAdditionOrUpdate',
          operationSignal,
        ),
      ),
    );
  }

  /** Deletes exact keys derived from the supplied tenant and source identity. */
  public async deleteDocuments(
    indexUid: string,
    organizationId: string,
    keys: readonly MeilisearchProjectionKey[],
    signal?: AbortSignal,
  ): Promise<void> {
    const index = this.indexPath(indexUid);
    const organization = organizationKey(organizationId);
    if (keys.length === 0) return;
    const body = encodeBatch(keys, (candidate) => {
      const parsed = projectionKey.safeParse(candidate);
      if (!parsed.success) throw new MeilisearchIndexError('invalid-request');
      const sourceId = normalizeSourceId(parsed.data);
      const id = `${organization}_${parsed.data.kind}_${sourceId}`;
      return { id, payload: id };
    });
    await this.withDeadline(signal, (operationSignal) =>
      this.mutateGeneration(index, indexUid, operationSignal, () =>
        this.submitTask(
          `${index}/documents/delete-batch`,
          'POST',
          body,
          indexUid,
          'documentDeletion',
          operationSignal,
        ),
      ),
    );
  }

  private indexPath(indexUid: string): string {
    if (!indexIdentifier.test(indexUid)) throw new MeilisearchIndexError('invalid-request');
    return `indexes/${indexUid}`;
  }

  private async requireGeneration(
    path: string,
    indexUid: string,
    signal: AbortSignal,
  ): Promise<string> {
    const result = generationIndex.safeParse(await this.requestJson(path, 'GET', 200, signal));
    if (!result.success || result.data.uid !== indexUid) {
      throw new MeilisearchIndexError('invalid-response');
    }
    return result.data.createdAt;
  }

  private async mutateGeneration(
    path: string,
    indexUid: string,
    signal: AbortSignal,
    mutate: () => Promise<void>,
  ): Promise<void> {
    // Meilisearch can lazily create a missing index when the writer has creation rights.
    const createdAt = await this.requireGeneration(path, indexUid, signal);
    await mutate();
    if ((await this.requireGeneration(path, indexUid, signal)) !== createdAt) {
      throw new MeilisearchIndexError('index-replaced');
    }
  }

  private async submitTask(
    path: string,
    method: 'POST' | 'PATCH',
    body: string,
    indexUid: string,
    type: TaskType,
    signal: AbortSignal,
  ): Promise<void> {
    const queued = enqueuedTask.safeParse(await this.requestJson(path, method, 202, signal, body));
    if (
      !queued.success ||
      (queued.data.indexUid !== null && queued.data.indexUid !== indexUid) ||
      queued.data.type !== type
    ) {
      throw new MeilisearchIndexError('invalid-response');
    }
    const taskUid = queued.data.taskUid;
    for (;;) {
      const result = taskResult.safeParse(
        await this.requestJson(`tasks/${String(taskUid)}`, 'GET', 200, signal),
      );
      if (
        !result.success ||
        result.data.uid !== taskUid ||
        result.data.indexUid !== indexUid ||
        result.data.type !== type
      ) {
        throw new MeilisearchIndexError('invalid-response');
      }
      const { status, error } = result.data;
      if (status === 'canceled') throw new MeilisearchIndexError('task-canceled');
      if (status === 'failed') {
        if (error?.code === 'index_not_found') throw new MeilisearchIndexError('index-not-found');
        if (type === 'indexCreation' && error?.code === 'index_already_exists') {
          throw new MeilisearchIndexError('index-already-exists');
        }
        throw new MeilisearchIndexError('task-failed');
      }
      if (error !== null) throw new MeilisearchIndexError('invalid-response');
      if (status === 'succeeded') return;
      await delay(this.pollIntervalMs, undefined, { signal });
    }
  }

  private async requestJson(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    expectedStatus: 200 | 202,
    signal: AbortSignal,
    body?: string,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(path === 'health' ? {} : { Authorization: `Bearer ${this.#apiKey}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    const response = await this.fetchRequest(new URL(path, this.baseUrl), {
      method,
      headers,
      body,
      redirect: 'error',
      signal,
    });
    if (response.status !== expectedStatus) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404 && path.startsWith('indexes/')) {
        throw new MeilisearchIndexError('index-not-found');
      }
      throw new MeilisearchIndexError('unavailable');
    }
    return this.readJson(response);
  }

  private async readJson(response: Response): Promise<unknown> {
    if (
      response.body === null ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? '')
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new MeilisearchIndexError('invalid-response');
    }
    const reader = response.body.getReader();
    const buffer = Buffer.alloc(maxResponseBytes);
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > maxResponseBytes) {
          void reader.cancel().catch(() => undefined);
          throw new MeilisearchIndexError('invalid-response');
        }
        buffer.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      return JSON.parse(text) as unknown;
    } catch {
      throw new MeilisearchIndexError('invalid-response');
    }
  }

  private async withDeadline(
    signal: AbortSignal | undefined,
    run: (operationSignal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const operationSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      operationSignal.throwIfAborted();
      await run(operationSignal);
      operationSignal.throwIfAborted();
    } catch (error: unknown) {
      if (signal?.aborted) throw new MeilisearchIndexError('aborted');
      if (timeout.aborted) throw new MeilisearchIndexError('timeout');
      if (error instanceof MeilisearchIndexError) throw error;
      throw new MeilisearchIndexError('unavailable');
    }
  }
  // #endregion
}
