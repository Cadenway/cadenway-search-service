# Search index

## Purpose

Owns the derived Meilisearch index and the runtime connection that updates it.

## Public entry points

None.

## Owned tables

- `search_rebuild_control` contains the singleton lock for generation selection and promotion.
- `search_index_generations` holds the physical index identity, stream observation and lifecycle.
  PostgreSQL permits one building and one active generation at a time.
- `search_export_checkpoints` contains the global organization roster checkpoint and per-tenant
  Task, list, space, Document and Storage checkpoints.
- `search_pending_refreshes` holds coalesced resource locators and claimed refreshes per generation.
- `search_refresh_receipts` holds the durable event IDs recorded with those refreshes.
- `search_terminal_advisories` records terminal broker deliveries by stream identity, consumer and
  sequence until the operator or a successful recovery resolves them.

These tables belong to Search and use forced system-only row-level security. They contain no
source resource contents.

## API

The service readiness check includes Meilisearch when the engine configuration is present.
It verifies both the engine status and the configured key's ability to read index metadata.

`GET /internal/v1/search` accepts a signed Gateway user with a selected organization. Meilisearch
provides ordered task and list candidates. Organization and Task are consulted before any
candidate name or continuation is returned. The selected results and visible lookahead receive
a final proof, and the route returns `private, no-store`. The cursor binds the user, organization,
normalized query and last visible sort key. A new request can continue after an index promotion.

## Events emitted

None.

## Events consumed

Search registers exact Task, list, space, comment, Document and Storage events when the engine
and authorities are configured. The handlers record current-state invalidations, keeping only
the event ID, organization, resource locators and stream sequence. An event replay uses the
persisted receipt even after the corresponding refresh has been applied.

## Invariants

- The index is rebuildable from the owning services.
- Projection keys include the organization and resource kind.
- Index mutations complete only after Meilisearch confirms the corresponding task succeeded.
- The worker confirms the durable stream and consumer identities of the active generation
  periodically. A confirmed replacement starts a rebuild. A candidate with a lost broker epoch
  or an expired uncertain write is abandoned with its UID. A rejected authority continuation
  abandons the candidate only while that cursor still matches unclaimed work.
- The promotion gate requires all authoritative exports to complete, a stable physical index and
  stream identity, the same caught-up durables, and no pending refreshes or unresolved terminal
  delivery advisories. An exact-filter durable can be caught up before the global stream's last
  sequence when no event matching its filter occupies the remaining positions.

## Transactions

Meilisearch tasks complete independently of PostgreSQL. Success is confirmed before a caller
can persist its position in a reconstruction.

Failed authoritative reads defer the affected refresh locator or export position for 30 seconds.
Ready work can progress independently, including across organizations and source services. A
deferred position remains incomplete for promotion, and a concurrent position change or
physical-write claim is preserved. Uncertain writes retain their original claims for recovery.

The promotion transaction locks `search_rebuild_control`, verifies the persisted coverage, then
retires the current generation and activates its successor in one commit. Broker and engine
observations are collected outside that transaction. Refresh recording and roster checkpoint
creation must use the same lock. Recording an organization from the roster creates its five
checkpoints in the same transaction as advancement of the roster cursor.

The Search-owned system transaction records the receipt and pending refreshes before the
subscription returns and the kit acknowledges delivery. The platform tables from the earlier
scaffold remain compatible with the preceding service image.

Receipt cleanup runs in batches of at most 1,000 after 45 days, which covers event retention and
the dead-letter replay window. A separate purge claims retired or abandoned generations with
an exact recorded identity after one hour, longer than the in-flight read and write deadlines.
Meilisearch deletion executes outside the claim transaction. The worker only marks a generation
purged after successful deletion or confirmed absence and retries uncertain attempts after five
minutes. The UID and creation identity stay recorded. An unbound candidate has not received
projection writes. Unbound and replaced identities are left for operator investigation.
An operator creating a replacement must use a new UID. The engine's deletion endpoint takes a
UID without a version precondition, so a UID is never reused.

## Decisions

- The index stores the organization as a filterable field. A search result still requires
  current authorization from the owning services.
- Configuring the engine allows the readiness probe to report it as a dependency.
- Hosted Search uses a dedicated key limited to `search_*` indexes with `search`, `indexes.get`,
  `indexes.create`, `indexes.delete`, `tasks.get`, `settings.update`, `documents.add` and
  `documents.delete` actions. The operator provisions that key before starting Search.
