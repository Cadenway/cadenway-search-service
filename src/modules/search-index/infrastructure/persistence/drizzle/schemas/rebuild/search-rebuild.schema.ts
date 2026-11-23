import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { SearchRebuildBrokerProgress } from '../../../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';

const systemAccess = sql`current_setting('app.system_access', true) = 'on'`;

export const searchRebuildControl = pgTable(
  'search_rebuild_control',
  {
    id: integer('id').primaryKey(),
  },
  (table) => [
    check('search_rebuild_control_singleton_check', sql`${table.id} = 1`),
    pgPolicy('search_rebuild_control_system_only', {
      using: systemAccess,
      withCheck: systemAccess,
    }),
  ],
).enableRLS();

export const searchIndexGenerations = pgTable(
  'search_index_generations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    indexUid: text('index_uid').notNull(),
    status: text('status').notNull(),
    engineCreatedAt: text('engine_created_at'),
    brokerAtStart: jsonb('broker_at_start').$type<SearchRebuildBrokerProgress>().notNull(),
    certifiedBrokerFrontier: bigint('certified_broker_frontier', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('search_index_generations_uid_unique').on(table.indexUid),
    uniqueIndex('search_index_generations_building_unique')
      .on(table.status)
      .where(sql`${table.status} = 'building'`),
    uniqueIndex('search_index_generations_active_unique')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
    index('search_index_generations_purge_index')
      .on(table.updatedAt, table.id)
      .where(
        sql`${table.status} in ('retired', 'abandoned') and ${table.engineCreatedAt} is not null and ${table.purgedAt} is null`,
      ),
    check(
      'search_index_generations_uid_length_check',
      sql`length(${table.indexUid}) between 1 and 512`,
    ),
    check(
      'search_index_generations_status_check',
      sql`${table.status} in ('building', 'active', 'abandoned', 'retired')`,
    ),
    check(
      'search_index_generations_frontier_check',
      sql`${table.certifiedBrokerFrontier} is null or ${table.certifiedBrokerFrontier} between 0 and 9007199254740991`,
    ),
    pgPolicy('search_index_generations_system_only', {
      using: systemAccess,
      withCheck: systemAccess,
    }),
  ],
).enableRLS();

export const searchExportCheckpoints = pgTable(
  'search_export_checkpoints',
  {
    generationId: uuid('generation_id')
      .notNull()
      .references(() => searchIndexGenerations.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    organizationId: uuid('organization_id'),
    cursor: text('cursor'),
    complete: boolean('complete').default(false).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    writeToken: uuid('write_token'),
    writeDeadline: timestamp('write_deadline', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('search_export_checkpoints_scope_unique')
      .on(table.generationId, table.source, table.organizationId)
      .nullsNotDistinct(),
    check(
      'search_export_checkpoints_source_check',
      sql`${table.source} in ('organization', 'task', 'list', 'space', 'document', 'storage')`,
    ),
    check(
      'search_export_checkpoints_scope_check',
      sql`(${table.source} = 'organization' and ${table.organizationId} is null) or (${table.source} <> 'organization' and ${table.organizationId} is not null)`,
    ),
    check(
      'search_export_checkpoints_cursor_length_check',
      sql`${table.cursor} is null or length(${table.cursor}) between 1 and 1024`,
    ),
    check(
      'search_export_checkpoints_write_check',
      sql`(${table.writeToken} is null and ${table.writeDeadline} is null) or (${table.writeToken} is not null and ${table.writeDeadline} is not null and ${table.organizationId} is not null and not ${table.complete})`,
    ),
    pgPolicy('search_export_checkpoints_system_only', {
      using: systemAccess,
      withCheck: systemAccess,
    }),
  ],
).enableRLS();

export const searchPendingRefreshes = pgTable(
  'search_pending_refreshes',
  {
    generationId: uuid('generation_id')
      .notNull()
      .references(() => searchIndexGenerations.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    resourceKind: text('resource_kind').notNull(),
    sourceId: text('source_id').notNull(),
    maxBrokerSequence: bigint('max_broker_sequence', { mode: 'number' }).notNull(),
    revision: bigint('revision', { mode: 'number' }).default(1).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    claimToken: uuid('claim_token'),
    claimDeadline: timestamp('claim_deadline', { withTimezone: true }),
    cascadePhase: text('cascade_phase'),
    cascadeCursor: text('cascade_cursor'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.generationId, table.organizationId, table.resourceKind, table.sourceId],
    }),
    index('search_pending_refreshes_claim_index').on(
      table.generationId,
      table.claimDeadline,
      table.maxBrokerSequence,
      table.organizationId,
      table.resourceKind,
      table.sourceId,
    ),
    check(
      'search_pending_refreshes_kind_check',
      sql`${table.resourceKind} in ('task', 'list', 'space', 'document', 'storage')`,
    ),
    check(
      'search_pending_refreshes_source_length_check',
      sql`length(${table.sourceId}) between 1 and 512`,
    ),
    check(
      'search_pending_refreshes_sequence_check',
      sql`${table.maxBrokerSequence} between 1 and 9007199254740991`,
    ),
    check(
      'search_pending_refreshes_revision_check',
      sql`${table.revision} between 1 and 9007199254740991`,
    ),
    check(
      'search_pending_refreshes_claim_check',
      sql`(${table.claimToken} is null and ${table.claimDeadline} is null) or (${table.claimToken} is not null and ${table.claimDeadline} is not null)`,
    ),
    check(
      'search_pending_refreshes_cascade_check',
      sql`(${table.cascadePhase} is null and ${table.cascadeCursor} is null) or (${table.cascadePhase} is not null and ${table.resourceKind} in ('list', 'space') and ${table.cascadePhase} in ('indexed', 'tasks', 'lists', 'self') and (${table.cascadePhase} <> 'lists' or ${table.resourceKind} = 'space') and (${table.cascadeCursor} is null or (${table.cascadePhase} <> 'self' and length(${table.cascadeCursor}) between 1 and 1024)))`,
    ),
    pgPolicy('search_pending_refreshes_system_only', {
      using: systemAccess,
      withCheck: systemAccess,
    }),
  ],
).enableRLS();

export const searchTerminalAdvisories = pgTable(
  'search_terminal_advisories',
  {
    stream: text('stream').notNull(),
    streamCreatedAt: text('stream_created_at').notNull(),
    consumer: text('consumer').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.stream, table.streamCreatedAt, table.consumer, table.sequence] }),
    index('search_terminal_advisories_unresolved_index')
      .on(table.createdAt)
      .where(sql`${table.resolvedAt} is null`),
    check(
      'search_terminal_advisories_sequence_check',
      sql`${table.sequence} between 1 and 9007199254740991`,
    ),
    pgPolicy('search_terminal_advisories_system_only', {
      using: systemAccess,
      withCheck: systemAccess,
    }),
  ],
).enableRLS();

export const searchRefreshReceipts = pgTable(
  'search_refresh_receipts',
  {
    eventId: uuid('event_id').primaryKey(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('search_refresh_receipts_processed_index').on(table.processedAt),
    pgPolicy('search_refresh_receipts_system_only', {
      using: systemAccess,
      withCheck: systemAccess,
    }),
  ],
).enableRLS();
