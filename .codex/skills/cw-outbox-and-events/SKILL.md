---
name: cw-outbox-and-events
description: "How to publish and consume events reliably with @cadenway/nest-messaging: outbox in the use case transaction, idempotent handlers, retries, dead letters, versioned names. Load it whenever an event is published or handled."
---

# Outbox and events

The wiring is in place (`src/app.module.ts`): `MessagingModule` connects as the NATS user
`search`, `OutboxModule` provides the writer, the relay and the deduplicator, and the platform
module (`src/modules/platform`) brings their tables into the migrations. The README of
`@cadenway/nest-messaging` is the reference for every call below. None of the events this service
indexes exists in `@cadenway/contracts` yet: an event is consumed only once its AsyncAPI spec is
released (`cw-contract-first`).

## Publishing

This service emits nothing: the `search` user of cadenway-ops may publish no `evt.` or `rebuild.`
subject, so no use case appends to the outbox. `OutboxModule` stays registered with its relay on all
the same: the relay purges the processed ids of `processed_events` after 14 days (and sent outbox
rows after 7), and the deduplicator of the handlers belongs to the same module. Never publish with
`EventPublisher` either. A need to publish starts with an AsyncAPI spec in cadenway-api-contracts
and a publish permission in cadenway-ops; the steps of the README of `@cadenway/nest-messaging`
(`OutboxWriter.append` inside the transaction of the use case) apply then.

## Consuming

1. Register the handler from `onApplicationBootstrap` of a provider of the `api/messaging/` layer,
   with the injected `EventConsumers`. It gets the durable consumer `search-service__<handler>`,
   filtered on the one subject of its event:

   ```ts
   await this.consumers.subscribe({
     handler: 'index-task',
     schemas: eventSchemas,
     event: 'task.created.v1',
     handle: async (payload, { claimVersion }) => {
       /* call the use case */
     },
   });
   ```
2. The deduplicator of `OutboxModule` records `(consumer, event id)` in `processed_events` in the
   handler's transaction (tenant runner for an event with an organization): a redelivery of a
   handled event is skipped. A `run` of the same runner inside the handler joins that transaction.
3. Call a use case; it is idempotent for anything outside the database (an e-mail, a call).
4. A rejection is retried after 1 s, 5 s, 30 s and 2 min; the fifth failure, or a payload that does
   not match its schema, becomes a dead letter in `EVENTS_DLQ`, copied by notification-service.
   Document in MODULE.md what an operator does with it.
5. A handler with outside effects registers with `deliverPolicy: 'new'`; the default `all` delivers
   up to seven days of events to a new consumer.

## Changing an event

- Additive field: minor change in cadenway-api-contracts; consumers ignore unknown fields.
- Any other change: a new name `.v2`, emitted alongside `.v1` until every consumer moved.

## Version and order

- Every event carries `version`, the version of the aggregate after the change, and `actor`
  (`{ type: 'user' | 'automation' | 'git' | 'system', id }`).
- Delivery is at least once and order is not guaranteed: `claimVersion(aggregateKey)` in the handler
  context (a key such as `task:<id>`) resolves to `false` for a version already applied to that
  aggregate in that organization.
- Never derive order from arrival time.

## What the kit and the broker own

Subjects (`evt.<name>`), durable pull consumers (`<service>__<handler>`), `Nats-Msg-Id`
deduplication, the retry schedule, the dead-letter copy and `traceparent` propagation belong to
`@cadenway/nest-messaging`. The three streams (`EVENTS`, `EVENTS_RESTRICTED`, `EVENTS_DLQ`) and the
permissions of the `search` user (no event or rebuild subject to publish, subscribe
`_INBOX.search.>` and `rebuild.search.>`) belong to cadenway-ops (`docs/messaging.md`). This service
runs with `manageStreams: false` and `deadLetterWorker: false`: never declare a stream, a consumer
or a subject here.

## Rebuilding a consumer

Outbox rows are kept 7 days. A consumer that fell further behind is rebuilt: the owning service
re-emits the current state of its entities with `RebuildEmitter` on `rebuild.<consumer>.<entity>`,
unacknowledged, the only mode the permissions allow. This service is that consumer: it receives the
rebuilds on `rebuild.search.<entity>` (`rebuild.search.task`), the only rebuild subjects it may
subscribe to, and emits none.
