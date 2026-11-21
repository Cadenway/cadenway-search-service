import { MAX_CALL_TIMEOUT_MS, ProblemException, remainingBudgetMs } from '@cadenway/nest-common';
import type { InternalHttpClient, InternalTokenClaims } from '@cadenway/nest-common';
import type { z } from 'zod';

import { SearchAuthorityReadError } from '../../../domain/errors/authority/search-authority-read.error.js';

const MAX_RESPONSE_BYTES = 1_048_576;

interface AuthorityRequest {
  // #region Properties
  /** Contract path and encoded operation parameters. */
  readonly path: string;
  readonly claims: InternalTokenClaims;
  readonly body?: object;
  readonly batchLimitCode?:
    'task.projection-batch-too-large' | 'document.projection-batch-too-large';
  readonly allowMissingMembership?: true;
  // #endregion
}

/** Scope an owner read to the Search system actor. The organization roster uses null. */
export function searchSystemClaims(organizationId: string | null): InternalTokenClaims {
  return { actor: { type: 'system', id: 'search-service' }, organizationId };
}

/** Delegate only the verified user and tenant identities needed by an access proof. */
export function searchUserClaims(organizationId: string, userId: string): InternalTokenClaims {
  return { actor: { type: 'user', id: userId }, organizationId };
}

/** Serialize only validated owner query fields. */
export function authorityQueryPath(path: string, query: Readonly<Record<string, unknown>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' || typeof value === 'number') search.set(key, String(value));
  }
  const params = search.toString();
  return params === '' ? path : `${path}?${params}`;
}

/** Validate an outbound operation without retaining request content on errors. */
export function parseAuthorityInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SearchAuthorityReadError('invalid-request');
  return result.data;
}

/** Read the contracted membership or its confirmed 404 absence. */
export function requestAuthorityJson<T>(
  client: Pick<InternalHttpClient, 'fetch'>,
  request: AuthorityRequest & { readonly allowMissingMembership: true },
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T | null>;
/** Read one complete contracted success response. */
export function requestAuthorityJson<T>(
  client: Pick<InternalHttpClient, 'fetch'>,
  request: AuthorityRequest & { readonly allowMissingMembership?: never },
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T>;
/** Validate the whole response before callers apply decisions to an index or access proof. */
export async function requestAuthorityJson<T>(
  client: Pick<InternalHttpClient, 'fetch'>,
  request: AuthorityRequest,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  const callerCancelled = (): boolean => signal?.aborted === true;
  if (callerCancelled()) throw new SearchAuthorityReadError('cancelled');
  const budgetMs = Math.floor(
    Math.min(MAX_CALL_TIMEOUT_MS, remainingBudgetMs() ?? MAX_CALL_TIMEOUT_MS),
  );
  if (budgetMs <= 0) throw new SearchAuthorityReadError('unavailable');
  const expiresAt = performance.now() + budgetMs;
  const timeout = AbortSignal.timeout(budgetMs);
  const deadline = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  try {
    const response = await client.fetch(request.path, {
      ...(request.body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.body),
            idempotent: true,
          }),
      claims: request.claims,
      cache: 'no-store',
      redirect: 'error',
      signal: deadline,
    });
    const wire = await readAuthorityBody(response, deadline);
    const result = schema.safeParse(wire);
    if (!result.success || !sameJsonValue(wire, result.data)) {
      throw new SearchAuthorityReadError('unavailable');
    }
    deadline.throwIfAborted();
    if (performance.now() >= expiresAt) throw new SearchAuthorityReadError('unavailable');
    return result.data;
  } catch (error) {
    if (callerCancelled()) throw new SearchAuthorityReadError('cancelled');
    if (!deadline.aborted && performance.now() < expiresAt && error instanceof ProblemException) {
      const { status, code } = error.problem;
      if (
        request.allowMissingMembership === true &&
        status === 404 &&
        code === 'organization.not-found'
      ) {
        return null;
      }
      if (status === 422 && code === request.batchLimitCode) {
        throw new SearchAuthorityReadError('batch-too-large');
      }
      if (status === 400 && code === 'request.invalid') {
        throw new SearchAuthorityReadError('invalid-request');
      }
    }
    throw new SearchAuthorityReadError('unavailable');
  }
}

async function readAuthorityBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = response.body;
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const cache = response.headers
    .get('cache-control')
    ?.split(',')
    .map((part) => part.trim().toLowerCase());
  const advertisedSize = response.headers.get('content-length');
  if (
    response.status !== 200 ||
    mediaType !== 'application/json' ||
    cache?.length !== 2 ||
    !cache.includes('private') ||
    !cache.includes('no-store') ||
    (advertisedSize !== null && Number(advertisedSize) > MAX_RESPONSE_BYTES) ||
    body === null
  ) {
    void body?.cancel().catch(() => undefined);
    throw new SearchAuthorityReadError('unavailable');
  }

  const reader = body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let contents = '';
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SearchAuthorityReadError('unavailable');
      contents += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(contents + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJsonValue(wire: unknown, parsed: unknown): boolean {
  if (wire === parsed) return true;
  if (Array.isArray(wire) && Array.isArray(parsed)) {
    return (
      wire.length === parsed.length &&
      wire.every((item, index) => sameJsonValue(item, parsed[index]))
    );
  }
  if (!isJsonRecord(wire) || !isJsonRecord(parsed)) return false;
  // Generated object validators can strip fields. Require the closed wire shape too.
  const keys = Object.keys(wire);
  return (
    keys.length === Object.keys(parsed).length &&
    keys.every((key) => Object.hasOwn(parsed, key) && sameJsonValue(wire[key], parsed[key]))
  );
}
