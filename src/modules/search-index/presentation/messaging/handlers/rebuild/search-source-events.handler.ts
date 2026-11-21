import {
  DOC_CREATED_V1,
  DOC_DELETED_V1,
  DOC_UPDATED_V1,
  eventSchemas as documentEvents,
} from '@cadenway/contracts/events/document-service';
import {
  FILE_DELETED_V1,
  FILE_UPLOADED_V1,
  eventSchemas as storageEvents,
} from '@cadenway/contracts/events/storage-service';
import {
  COMMENT_CREATED_V1,
  COMMENT_DELETED_V1,
  COMMENT_UPDATED_V1,
  LIST_ACCESS_CHANGED_V1,
  LIST_ARCHIVED_V1,
  LIST_CREATED_V1,
  LIST_DELETED_V1,
  LIST_RESTORED_V1,
  LIST_UNARCHIVED_V1,
  LIST_UPDATED_V1,
  SPACE_ACCESS_CHANGED_V1,
  SPACE_ACCESS_REPUBLISHED_V1,
  SPACE_CREATED_V1,
  SPACE_DELETED_V1,
  SPACE_RESTORED_V1,
  SPACE_UPDATED_V1,
  TASK_ARCHIVED_V1,
  TASK_CREATED_V1,
  TASK_PURGED_V1,
  TASK_RESTORED_V1,
  TASK_TRASHED_V1,
  TASK_UNARCHIVED_V1,
  TASK_UPDATED_V1,
  TASK_WATCHER_CHANGED_V1,
  eventSchemas as taskEvents,
} from '@cadenway/contracts/events/task-service';
import type {
  EventConsumers,
  EventNameOf,
  EventPayloadOf,
  EventSchemas,
} from '@cadenway/nest-messaging';

import type { SearchRefreshTarget } from '../../../../application/models/rebuild/search-refresh-target.model.js';
import type { RecordSearchRefreshes } from '../../../../application/use-cases/commands/rebuild/record-search-refreshes/record-search-refreshes.use-case.js';

const taskChanges = [
  TASK_CREATED_V1,
  TASK_UPDATED_V1,
  TASK_ARCHIVED_V1,
  TASK_UNARCHIVED_V1,
  TASK_TRASHED_V1,
  TASK_RESTORED_V1,
  TASK_PURGED_V1,
  TASK_WATCHER_CHANGED_V1,
  // Comment changes advance the task version without emitting task.updated.
  COMMENT_CREATED_V1,
  COMMENT_UPDATED_V1,
  COMMENT_DELETED_V1,
] as const;
const listChanges = [
  LIST_CREATED_V1,
  LIST_UPDATED_V1,
  LIST_ARCHIVED_V1,
  LIST_UNARCHIVED_V1,
  LIST_DELETED_V1,
  LIST_RESTORED_V1,
  LIST_ACCESS_CHANGED_V1,
] as const;
const spaceChanges = [
  SPACE_CREATED_V1,
  SPACE_UPDATED_V1,
  SPACE_DELETED_V1,
  SPACE_RESTORED_V1,
  SPACE_ACCESS_CHANGED_V1,
  SPACE_ACCESS_REPUBLISHED_V1,
] as const;
const documentChanges = [DOC_CREATED_V1, DOC_UPDATED_V1, DOC_DELETED_V1] as const;
const storageChanges = [FILE_UPLOADED_V1, FILE_DELETED_V1] as const;

/** Stable local handler names used to sample these durables when promoting a generation. */
export const searchSourceHandlerNames: readonly string[] = [
  ...taskChanges,
  ...listChanges,
  ...spaceChanges,
  ...documentChanges,
  ...storageChanges,
].map(handlerName);

/** Registers the Search invalidations. Each handler awaits the committed queue write before ACK. */
export async function subscribeSearchSourceEvents(
  consumers: Pick<EventConsumers, 'subscribe'>,
  record: Pick<RecordSearchRefreshes, 'execute'>,
): Promise<void> {
  await subscribeGroup(consumers, record, taskEvents, taskChanges, 'task', ({ key }) => key);
  await subscribeGroup(consumers, record, taskEvents, listChanges, 'list', ({ listId }) => listId);
  await subscribeGroup(
    consumers,
    record,
    taskEvents,
    spaceChanges,
    'space',
    ({ spaceId }) => spaceId,
  );
  await subscribeGroup(
    consumers,
    record,
    documentEvents,
    documentChanges,
    'document',
    ({ documentId }) => documentId,
  );
  await subscribeGroup(
    consumers,
    record,
    storageEvents,
    storageChanges,
    'storage',
    ({ fileId }) => fileId,
  );
}

async function subscribeGroup<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
  consumers: Pick<EventConsumers, 'subscribe'>,
  record: Pick<RecordSearchRefreshes, 'execute'>,
  schemas: TSchemas,
  names: readonly TName[],
  kind: SearchRefreshTarget['kind'],
  getSourceId: (payload: EventPayloadOf<TSchemas, TName>) => string,
): Promise<void> {
  for (const event of names) {
    await consumers.subscribe({
      handler: handlerName(event),
      schemas,
      event,
      deliverPolicy: 'all',
      handle: async (payload, context): Promise<void> => {
        context.signal.throwIfAborted();
        const { id: eventId, organizationId } = payload;
        if (organizationId === null) throw new Error('A Search source event requires a tenant.');
        await record.execute({
          eventId,
          brokerSequence: context.streamSequence,
          targets: [{ organizationId, kind, sourceId: getSourceId(payload) }],
        });
      },
    });
  }
}

function handlerName(event: string): string {
  return `index-${event.replaceAll('.', '-')}`;
}
