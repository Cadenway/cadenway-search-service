# Search index

## Purpose

Owns the derived Meilisearch index and the runtime connection that updates it.

## Public entry points

None.

## Owned tables

None.

## API

The service readiness check includes Meilisearch when the engine configuration is present.
It verifies both the engine status and the configured key's ability to read index metadata.

## Events emitted

None.

## Events consumed

None.

## Invariants

- The index is rebuildable from the owning services.
- Projection keys include the organization and resource kind.
- Index mutations complete only after Meilisearch confirms the corresponding task succeeded.

## Transactions

Meilisearch tasks complete independently of PostgreSQL. Success is confirmed before a caller
can persist its position in a reconstruction.

## Decisions

- The index stores the organization as a filterable field. A search result still requires
  current authorization from the owning services.
- Configuring the engine allows the readiness probe to report it as a dependency.
