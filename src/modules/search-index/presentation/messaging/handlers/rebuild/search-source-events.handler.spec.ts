import { validateEvent } from '@cadenway/nest-messaging';
import type {
  EventContext,
  EventNameOf,
  EventSchemas,
  EventSubscription,
} from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { RecordSearchRefreshes } from '../../../../application/use-cases/commands/rebuild/record-search-refreshes/record-search-refreshes.use-case.js';

import {
  searchSourceHandlerNames,
  subscribeSearchSourceEvents,
} from './search-source-events.handler.js';

const id = '0195e018-6b43-76be-9afb-afc6d521f851';
const organizationId = '0195e018-6b43-76be-9afb-afc6d521f852';
const listId = '0195e018-6b43-76be-9afb-afc6d521f853';
const spaceId = '0195e018-6b43-76be-9afb-afc6d521f854';
const documentId = '0195e018-6b43-76be-9afb-afc6d521f855';
const fileId = '0195e018-6b43-76be-9afb-afc6d521f856';
const entryId = '0195e018-6b43-76be-9afb-afc6d521f857';
const envelope = {
  id,
  organizationId,
  actor: { type: 'system', id: 'test-fixture' },
  occurredAt: '2026-05-15T12:00:00.000Z',
  version: 4,
};
const purgedTask = {
  ...envelope,
  key: 'CAD-22',
  entryId,
  rootKey: 'CAD-21',
  parentKey: 'CAD-21',
  listId,
  spaceId,
};

async function bindings(): Promise<{
  execute: ReturnType<typeof vi.fn<RecordSearchRefreshes['execute']>>;
  registered: Map<string, { event: string; deliverPolicy: 'all' | 'new' | undefined }>;
  deliver: (handler: string, input: unknown, signal?: AbortSignal) => Promise<void>;
}> {
  const execute = vi.fn<RecordSearchRefreshes['execute']>().mockResolvedValue(undefined);
  const registered = new Map<string, { event: string; deliverPolicy: 'all' | 'new' | undefined }>();
  const callbacks = new Map<string, (input: unknown, context: EventContext) => Promise<void>>();
  await subscribeSearchSourceEvents(
    {
      subscribe<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
        input: EventSubscription<TSchemas, TName>,
      ): Promise<void> {
        registered.set(input.handler, { event: input.event, deliverPolicy: input.deliverPolicy });
        callbacks.set(input.handler, (payload, context) =>
          input.handle(validateEvent(input.schemas, input.event, payload), context),
        );
        return Promise.resolve();
      },
    },
    { execute },
  );
  return {
    execute,
    registered,
    deliver: async (handler, input, signal = new AbortController().signal) => {
      const callback = callbacks.get(handler);
      if (callback === undefined) throw new Error('The test handler was not registered.');
      await callback(input, {
        deliveryCount: 1,
        streamSequence: 80,
        redelivered: false,
        claimVersion: () =>
          Promise.reject(new Error('Invalidation does not compare aggregate versions.')),
        signal,
      });
    },
  };
}

describe('Search source event bindings', () => {
  it('registers the exact versioned local names used to sample the Search consumer fleet', async () => {
    const fixture = await bindings();
    expect(searchSourceHandlerNames).toHaveLength(29);
    expect([...fixture.registered.keys()]).toEqual(searchSourceHandlerNames);
    for (const [handler, registration] of fixture.registered) {
      expect(handler).toBe(`index-${registration.event.replaceAll('.', '-')}`);
      expect(registration.deliverPolicy).toBe('all');
      expect(registration.event).toMatch(/^(task|comment|list|space|doc|file)\.[a-z-]+\.v1$/u);
    }
  });

  it.each([
    ['index-task-purged-v1', purgedTask, 'task', 'CAD-22'],
    [
      'index-comment-deleted-v1',
      { ...envelope, key: 'CAD-22', listId, spaceId, commentId: entryId, commentVersion: 2 },
      'task',
      'CAD-22',
    ],
    ['index-list-deleted-v1', { ...envelope, listId, spaceId }, 'list', listId],
    ['index-space-deleted-v1', { ...envelope, spaceId }, 'space', spaceId],
    ['index-doc-deleted-v1', { ...envelope, documentId, spaceId }, 'document', documentId],
    [
      'index-file-deleted-v1',
      { ...envelope, fileId, taskKey: 'CAD-21', sizeBytes: 1024 },
      'storage',
      fileId,
    ],
  ])(
    'queues only the tenant and stable source ID for %s',
    async (handler, payload, kind, sourceId) => {
      const fixture = await bindings();
      await fixture.deliver(handler, payload);
      expect(fixture.execute).toHaveBeenCalledExactlyOnceWith({
        eventId: id,
        brokerSequence: 80,
        targets: [{ organizationId, kind, sourceId }],
      });
    },
  );

  it('rejects malformed and cancelled deliveries before writing the queue', async () => {
    const fixture = await bindings();
    await expect(
      fixture.deliver('index-task-purged-v1', { ...purgedTask, organizationId: null }),
    ).rejects.toThrow();
    await expect(
      fixture.deliver('index-task-purged-v1', purgedTask, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('waits for a queue write and propagates its failure to the broker handler', async () => {
    const fixture = await bindings();
    const failure = new Error('queue unavailable');
    fixture.execute.mockRejectedValueOnce(failure);
    await expect(fixture.deliver('index-task-purged-v1', purgedTask)).rejects.toBe(failure);
  });
});
