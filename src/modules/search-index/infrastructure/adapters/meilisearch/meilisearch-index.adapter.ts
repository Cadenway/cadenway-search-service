import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { STATUS_KEYS } from '@cadenway/contracts';
import type { Settings } from 'meilisearch';
import { z } from 'zod';

import type { PaletteCandidateReader } from '../../../application/ports/outbound/search/palette/palette-candidate-reader.port.js';
import type { SearchParentDescendantReader } from '../../../application/ports/outbound/search/rebuild/search-parent-descendant-reader.port.js';
import { LiteralSearchOrderError } from '../../../domain/errors/literal-search/literal-search-order.error.js';
import { literalSearchOrderKey } from '../../../domain/policies/literal-search/literal-search-order.policy.js';
import { buildLiteralSearchIndexTerms } from '../../../domain/policies/literal-search/literal-search.policy.js';

import { MeilisearchIndexError } from './meilisearch-index.error.js';
import type { MeilisearchIndexDocument } from './meilisearch-index-document.js';
import { MEILISEARCH_SEARCH_CUTOFF_MS } from './meilisearch-keyset-search.js';
import { MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS } from './meilisearch-literal-search-sort-fields.js';
import {
  buildMeilisearchPaletteRequest,
  readMeilisearchPaletteResponse,
} from './meilisearch-palette-search.js';
import {
  buildMeilisearchDescendantsRequest,
  readMeilisearchDescendantsResponse,
} from './meilisearch-parent-descendants.js';
import type { MeilisearchProjectionKey } from './meilisearch-projection-key.js';

const primaryKey = 'projectionId';
const maxBatchItems = 100;
const maxBatchBytes = 1_048_576;
const maxResponseBytes = 65_536;
// 101 hits with 300-code-point task titles, JSON escaping and bounded locator fields.
const maxPaletteResponseBytes = 262_144;
const maxTimerMs = 2_147_483_647;
const indexIdentifier = /^[a-zA-Z0-9_-]{1,128}$/u;
const kind = z.enum(['task', 'list', 'space', 'document', 'attachment']);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const keyFields = { kind, sourceId: z.string().regex(indexIdentifier) };
const projectionKey = z.strictObject(keyFields);
const indexDocument = z
  .strictObject({
    ...keyFields,
    organizationId: uuid,
    version: z.int().positive(),
    title: z.string().min(1).max(512),
    status: z.enum(STATUS_KEYS).optional(),
    text: z.string().max(200_000).optional(),
    listId: uuid.optional(),
    spaceId: uuid.optional(),
    taskKey: z.string().regex(indexIdentifier).optional(),
  })
  .refine((value) => (value.kind === 'task') === (value.status !== undefined));
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
const generationCreatedAt = z.iso.datetime({ offset: true });
const activeGeneration = z.object({
  id: uuid,
  indexUid: z.string().regex(indexIdentifier),
  engineCreatedAt: generationCreatedAt,
});
const indexMetadata = z.object({
  uid: z.string().min(1),
  primaryKey: z.string().nullable(),
  createdAt: generationCreatedAt,
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

  /** Reads the current durable generation pointer on each call. Required for palette reads. */
  readonly findActiveGeneration?: (signal: AbortSignal) => Promise<{
    readonly id: string;
    readonly indexUid: string;
    readonly engineCreatedAt: string | null;
  } | null>;
  // #endregion
}

type TaskType =
  'indexCreation' | 'settingsUpdate' | 'documentAdditionOrUpdate' | 'documentDeletion';

const documentMutations = {
  upsert: { suffix: 'documents', type: 'documentAdditionOrUpdate' },
  delete: { suffix: 'documents/delete-batch', type: 'documentDeletion' },
} as const;

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

function encodeBatches<T>(
  items: readonly T[],
  project: (item: T) => { readonly id: string; readonly payload: object | string },
): readonly (readonly string[])[] {
  if (items.length > maxBatchItems) throw new MeilisearchIndexError('batch-too-large');
  const ids = new Set<string>();
  const batches: string[][] = [];
  let chunks: string[] = [];
  let size = 2;
  for (const item of items) {
    const { id, payload } = project(item);
    if (ids.has(id)) throw new MeilisearchIndexError('invalid-request');
    const encoded = JSON.stringify(payload);
    const itemSize = Buffer.byteLength(encoded, 'utf8');
    if (itemSize + 2 > maxBatchBytes) throw new MeilisearchIndexError('batch-too-large');
    if (size + itemSize + (chunks.length === 0 ? 0 : 1) > maxBatchBytes) {
      batches.push(chunks);
      chunks = [];
      size = 2;
    }
    size += itemSize + (chunks.length === 0 ? 0 : 1);
    ids.add(id);
    chunks.push(encoded);
  }
  if (chunks.length !== 0) batches.push(chunks);
  return batches;
}

function literalCandidateFields(
  documentKind: MeilisearchProjectionKey['kind'],
  title: string,
  sourceId: string,
) {
  if (documentKind !== 'task' && documentKind !== 'list') return {};
  try {
    const [kindRank, orderHigh, orderMiddle, orderLow] = literalSearchOrderKey(
      documentKind,
      sourceId,
    );
    return {
      literalTerms: buildLiteralSearchIndexTerms(
        title,
        documentKind === 'task' ? sourceId : undefined,
      ),
      kindRank,
      orderHigh,
      orderMiddle,
      orderLow,
    };
  } catch (error: unknown) {
    if (error instanceof LiteralSearchOrderError)
      throw new MeilisearchIndexError('invalid-request');
    throw error;
  }
}

/** Reads and writes the verified Meilisearch generations. */
export class MeilisearchIndexAdapter implements PaletteCandidateReader {
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

  /** Durable lookup of the active pointer, supplied by the palette composition. */
  private readonly findActiveGeneration: IndexAdapterOptions['findActiveGeneration'];
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
    this.findActiveGeneration = options.findActiveGeneration;
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

  /** Reads the current generation's exact creation timestamp from Meilisearch. */
  public async readGenerationIdentity(indexUid: string, signal?: AbortSignal): Promise<string> {
    const index = this.indexPath(indexUid);
    return this.withDeadline(signal, (operationSignal) =>
      this.requireGeneration(index, indexUid, operationSignal),
    );
  }

  /** Reads a page, verifying both the durable pointer and the physical index around the operation. */
  public async read(
    input: Parameters<PaletteCandidateReader['read']>[0],
  ): ReturnType<PaletteCandidateReader['read']> {
    const organization = organizationKey(input.organizationId);
    const body = JSON.stringify(
      buildMeilisearchPaletteRequest(organization, input.normalizedQuery, input.after, input.limit),
    );
    const requested = uuid.nullable().safeParse(input.generation);
    if (!requested.success) throw new MeilisearchIndexError('invalid-request');
    const lookup = this.findActiveGeneration;
    if (lookup === undefined) throw new MeilisearchIndexError('unavailable');

    return this.withDeadline(input.signal, async (signal) => {
      const generation = activeGeneration.safeParse(await lookup(signal));
      if (!generation.success) throw new MeilisearchIndexError('unavailable');
      const { id, indexUid, engineCreatedAt } = generation.data;
      if (requested.data !== null && id !== requested.data) {
        throw new MeilisearchIndexError('index-replaced');
      }
      const index = this.indexPath(indexUid);
      await this.assertGeneration(index, indexUid, engineCreatedAt, signal);
      const response = await this.requestJson(
        `${index}/search`,
        'POST',
        200,
        signal,
        body,
        maxPaletteResponseBytes,
      );
      const hits = readMeilisearchPaletteResponse(response, organization, input.after, input.limit);
      await this.assertGeneration(index, indexUid, engineCreatedAt, signal);
      const latest = activeGeneration.safeParse(await lookup(signal));
      if (
        !latest.success ||
        latest.data.id !== id ||
        latest.data.indexUid !== indexUid ||
        latest.data.engineCreatedAt !== engineCreatedAt
      ) {
        throw new MeilisearchIndexError('index-replaced');
      }
      return {
        generation: id,
        items: hits.slice(0, input.limit),
        hasMore: hits.length > input.limit,
      };
    });
  }

  /** Reads indexed child locators from a known generation, including one bounded lookahead. */
  public async readDescendants(
    input: Parameters<SearchParentDescendantReader['read']>[0],
  ): ReturnType<SearchParentDescendantReader['read']> {
    const { scope, after, request } = buildMeilisearchDescendantsRequest(input);
    const index = this.indexPath(scope.indexUid);
    return this.withDeadline(input.signal, async (signal) => {
      await this.assertGeneration(index, scope.indexUid, scope.engineCreatedAt, signal);
      const body = await this.requestJson(
        `${index}/search`,
        'POST',
        200,
        signal,
        JSON.stringify(request),
      );
      const page = readMeilisearchDescendantsResponse(body, scope, after, input.limit);
      await this.assertGeneration(index, scope.indexUid, scope.engineCreatedAt, signal);
      return page;
    });
  }

  /** Creates a new generation and returns its exact identity after the settings task succeeds. */
  public async createGeneration(indexUid: string, signal?: AbortSignal): Promise<string> {
    const index = this.indexPath(indexUid);
    return this.withDeadline(signal, async (operationSignal) => {
      // A generation with an unseen creation outcome cannot be adopted by its UID alone.
      await this.submitTask(
        'indexes',
        'POST',
        JSON.stringify({ uid: indexUid, primaryKey }),
        indexUid,
        'indexCreation',
        operationSignal,
      );
      const createdAt = await this.requireGeneration(index, indexUid, operationSignal);
      await this.submitTask(
        `${index}/settings`,
        'PATCH',
        JSON.stringify({
          filterableAttributes: [
            'organizationId',
            'kind',
            'literalTerms',
            'listId',
            'spaceId',
            ...MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS,
          ],
          sortableAttributes: [...MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS],
          searchableAttributes: ['title', 'sourceId', 'taskKey', 'text'],
          searchCutoffMs: MEILISEARCH_SEARCH_CUTOFF_MS,
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
            'status',
            ...MEILISEARCH_LITERAL_SEARCH_SORT_FIELDS,
          ],
        } satisfies Settings),
        indexUid,
        'settingsUpdate',
        operationSignal,
      );
      await this.assertGeneration(index, indexUid, createdAt, operationSignal);
      return createdAt;
    });
  }

  /** Replaces whole tenant projections against the persisted generation identity. */
  public async upsertDocuments(
    indexUid: string,
    expectedCreatedAt: string,
    organizationId: string,
    documents: readonly MeilisearchIndexDocument[],
    signal?: AbortSignal,
  ): Promise<void> {
    const organization = organizationKey(organizationId);
    const batches = encodeBatches(documents, (candidate) => {
      const parsed = indexDocument.safeParse(candidate);
      if (!parsed.success || parsed.data.organizationId !== organization) {
        throw new MeilisearchIndexError('invalid-request');
      }
      const document = parsed.data;
      const sourceId = normalizeSourceId(document);
      const id = `${organization}_${document.kind}_${sourceId}`;
      return {
        id,
        payload: {
          ...document,
          sourceId,
          [primaryKey]: id,
          ...literalCandidateFields(document.kind, document.title, sourceId),
        },
      };
    });
    await this.withDeadline(signal, (operationSignal) =>
      this.writeBatches(indexUid, expectedCreatedAt, 'upsert', batches, operationSignal),
    );
  }

  /** Deletes exact tenant keys against the persisted generation identity. */
  public async deleteDocuments(
    indexUid: string,
    expectedCreatedAt: string,
    organizationId: string,
    keys: readonly MeilisearchProjectionKey[],
    signal?: AbortSignal,
  ): Promise<void> {
    const organization = organizationKey(organizationId);
    const batches = encodeBatches(keys, (candidate) => {
      const parsed = projectionKey.safeParse(candidate);
      if (!parsed.success) throw new MeilisearchIndexError('invalid-request');
      const sourceId = normalizeSourceId(parsed.data);
      const id = `${organization}_${parsed.data.kind}_${sourceId}`;
      return { id, payload: id };
    });
    await this.withDeadline(signal, (operationSignal) =>
      this.writeBatches(indexUid, expectedCreatedAt, 'delete', batches, operationSignal),
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

  private async writeBatches(
    indexUid: string,
    expectedCreatedAt: string,
    mutation: keyof typeof documentMutations,
    batches: readonly (readonly string[])[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!generationCreatedAt.safeParse(expectedCreatedAt).success) {
      throw new MeilisearchIndexError('invalid-request');
    }
    const path = this.indexPath(indexUid);
    if (batches.length === 0) {
      await this.assertGeneration(path, indexUid, expectedCreatedAt, signal);
    }
    const { suffix, type } = documentMutations[mutation];
    for (const chunks of batches) {
      // Meilisearch can lazily create a missing index when the writer has creation rights.
      await this.assertGeneration(path, indexUid, expectedCreatedAt, signal);
      const body = `[${chunks.join(',')}]`;
      await this.submitTask(`${path}/${suffix}`, 'POST', body, indexUid, type, signal);
      await this.assertGeneration(path, indexUid, expectedCreatedAt, signal);
    }
  }

  private async assertGeneration(
    path: string,
    indexUid: string,
    expectedCreatedAt: string,
    signal: AbortSignal,
  ): Promise<void> {
    if ((await this.requireGeneration(path, indexUid, signal)) !== expectedCreatedAt) {
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
    maxBytes = maxResponseBytes,
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
      cache: 'no-store',
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
    return this.readJson(response, maxBytes, signal);
  }

  private async readJson(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (
      response.body === null ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? '')
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new MeilisearchIndexError('invalid-response');
    }
    const reader = response.body.getReader();
    const buffer = Buffer.alloc(maxBytes);
    const cancel = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let size = 0;
    try {
      if (signal.aborted) cancel();
      signal.throwIfAborted();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > maxBytes) {
          cancel();
          throw new MeilisearchIndexError('invalid-response');
        }
        buffer.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
    signal.throwIfAborted();
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      return JSON.parse(text) as unknown;
    } catch {
      throw new MeilisearchIndexError('invalid-response');
    }
  }

  private async withDeadline<T>(
    signal: AbortSignal | undefined,
    run: (operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const operationSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const listener = new AbortController();
    try {
      operationSignal.throwIfAborted();
      const interrupted = once(operationSignal, 'abort', { signal: listener.signal }).then(() => {
        throw new MeilisearchIndexError('aborted');
      });
      const running = Promise.resolve().then(() => run(operationSignal));
      const value = await Promise.race([running, interrupted]);
      operationSignal.throwIfAborted();
      return value;
    } catch (error: unknown) {
      if (signal?.aborted) throw new MeilisearchIndexError('aborted');
      if (timeout.aborted) throw new MeilisearchIndexError('timeout');
      if (error instanceof MeilisearchIndexError) throw error;
      throw new MeilisearchIndexError('unavailable');
    } finally {
      listener.abort();
    }
  }
  // #endregion
}
