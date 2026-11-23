import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  createApplication,
  InternalTokenSigner,
  loadConfig,
  runWithOrganizationContext,
} from '@cadenway/nest-common';
import type {
  Ed25519PrivateJwk,
  Ed25519PublicJwk,
  OrganizationContext,
} from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { appConfigSchema } from '../src/config/app-config.js';
import { PromoteSearchRebuild } from '../src/modules/search-index/application/use-cases/commands/rebuild/promote-search-rebuild/promote-search-rebuild.use-case.js';
import { ClaimSearchExportPage } from '../src/modules/search-index/application/use-cases/commands/rebuild/claim-search-export-page/claim-search-export-page.use-case.js';
import { RecordSearchRefreshes } from '../src/modules/search-index/application/use-cases/commands/rebuild/record-search-refreshes/record-search-refreshes.use-case.js';
import { DrizzleSearchParentReconciliation } from '../src/modules/search-index/infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-parent-reconciliation.unit-of-work.js';
import { DrizzleSearchRuntimeStateRepository } from '../src/modules/search-index/infrastructure/persistence/drizzle/repositories/rebuild/drizzle-search-runtime-state.repository.js';
import { DrizzleSearchRebuildExportUnitOfWork } from '../src/modules/search-index/infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-rebuild-export.unit-of-work.js';
import { DrizzleSearchGenerationUnitOfWork } from '../src/modules/search-index/infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-generation.unit-of-work.js';
import { DrizzleSearchRebuildPromotionUnitOfWork } from '../src/modules/search-index/infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-rebuild-promotion.unit-of-work.js';
import { DrizzleSearchRefreshUnitOfWork } from '../src/modules/search-index/infrastructure/persistence/drizzle/transactions/rebuild/drizzle-search-refresh.unit-of-work.js';

// The service as main.ts assembles it, on a disposable PostgreSQL and NATS. `@cadenway/nest-testing`
// does not export its container fixtures yet and a service never depends on `testcontainers` itself,
// so the dependencies are those of compose.dev.yaml, started as a throwaway Compose project on free
// ports: PostgreSQL with the two roles of cadenway-ops, NATS with its authorization (the `search`
// user, which may publish no event, and the inbox prefix `_INBOX.search`) and its three streams.

/** Compose file of the development dependencies. */
const composeFile: string = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));

/** Throwaway project name: it never touches the data of the developer's own dev stack. */
const project = `cadenway-search-service-test-${String(process.pid)}`;

/**
 * Host port of NATS. Fixed for the run, unlike the ephemeral port of PostgreSQL: the service must
 * find NATS at the same address after the test restarts it, and Docker gives an ephemeral mapping a
 * new port at each start.
 */
let natsHostPort = '0';

/** Atelier Nord, the organization of the mockup. */
const atelierNordId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';

/** Another organization, which must never see a row of Atelier Nord. */
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';

/** Camille Martin (CM), the member of Atelier Nord the mockup signs in as. */
const camilleMartinId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';

/** The tables of the platform module, as the kit names them. */
const platformTables = [
  'event_versions',
  'idempotency_keys',
  'outbox_events',
  'processed_events',
] as const;

/** The Search rebuild state is accessible only to a system transaction. */
const rebuildTables = [
  'search_export_checkpoints',
  'search_index_generations',
  'search_pending_refreshes',
  'search_rebuild_control',
  'search_refresh_receipts',
  'search_terminal_advisories',
] as const;

/**
 * Runs `docker compose` on the throwaway project.
 *
 * @param args - Compose command and its arguments.
 * @returns The standard output.
 */
function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0', DEV_NATS_PORT: natsHostPort },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Runs the NATS command line of the `nats-streams` container against the broker of the project.
 *
 * @param env - Variables that replace the `admin` credentials of the container for this call.
 * @param args - Arguments of the `nats` command.
 * @returns Whether the broker accepted the command.
 */
function brokerAccepts(env: Readonly<Record<string, string>>, ...args: readonly string[]): boolean {
  const variables = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
  try {
    compose('exec', '-T', ...variables, 'nats-streams', 'nats', '--timeout', '2s', ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a port of the loopback interface that nothing listens on.
 *
 * @returns A free port, released before it is returned.
 */
async function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('The probe server has no TCP address.'));
        } else {
          resolve(String(address.port));
        }
      });
    });
  });
}

/**
 * Reads the published host port of a service of the project.
 *
 * @param service - Compose service.
 * @param port - Port inside the container.
 * @returns The host port.
 */
function hostPort(service: string, port: string): string {
  return compose('port', service, port).trim().split(':').at(-1) ?? '';
}

/**
 * Creates an Ed25519 key pair in the JWK forms the internal token uses.
 *
 * @returns The public key for the verifier and the private key for a signer.
 */
function keyPair(): {
  readonly publicJwk: Ed25519PublicJwk;
  readonly privateJwk: Ed25519PrivateJwk;
} {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) {
    throw new Error('Node returned an Ed25519 JWK without its key material.');
  }
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: 'test-api-gateway' };
  return { publicJwk, privateJwk: { ...publicJwk, d } };
}

/**
 * The organization context of a member of an organization, as the internal token gives it.
 *
 * @param organizationId - Organization of the context.
 * @returns The context the tenant runner reads.
 */
function memberOf(organizationId: string): OrganizationContext {
  return {
    organizationId,
    actor: { type: 'user', id: camilleMartinId },
    role: null,
    scopes: [],
  };
}

/**
 * Applies the migrations with `src/migrate.ts`, the entry point of the migration container, as
 * the migrator role. Each call imports the module afresh, as each container start runs it once.
 */
async function runMigrator(): Promise<void> {
  vi.resetModules();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await import('../src/migrate.js');
  } finally {
    log.mockRestore();
  }
}

/** Releases the shutdown held by `ShutdownGate`. */
let releaseShutdown: () => void = () => undefined;

/** Settles once `releaseShutdown` is called. */
const shutdownReleased = new Promise<void>((resolve) => {
  releaseShutdown = resolve;
});

/**
 * Holds the shutdown after readiness turned down and before the listener closes, the way a slow
 * handler or relay pass would, so the probes can be read during the stop.
 */
@Injectable()
class ShutdownGate implements BeforeApplicationShutdown {
  public async beforeApplicationShutdown(): Promise<void> {
    await shutdownReleased;
  }
}

/** A route of the application that declares no exemption, like every business route will. */
@Controller('internal/v1/wiring-probe')
class WiringProbeController {
  @Get()
  public probe(): { readonly reached: true } {
    return { reached: true };
  }
}

describe('search-service wiring', () => {
  const gateway = keyPair();
  let app: NestExpressApplication | undefined;
  let signer: InternalTokenSigner;
  let migrator: pg.Pool;
  let postgresPort: string;

  /**
   * The running application.
   *
   * @returns The application created in `beforeAll`.
   */
  function service(): NestExpressApplication {
    if (app === undefined) {
      throw new Error('The application did not start.');
    }
    return app;
  }

  beforeAll(async () => {
    natsHostPort = await freePort();
    compose(
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'nats',
      'nats-streams',
    );
    postgresPort = hostPort('postgres', '5432');

    vi.stubEnv(
      'MIGRATION_DATABASE_URL',
      `postgres://search_migrator:search_migrator@127.0.0.1:${postgresPort}/search`,
    );
    await runMigrator();
    migrator = new pg.Pool({
      connectionString: `postgres://search_migrator:search_migrator@127.0.0.1:${postgresPort}/search`,
      max: 1,
      // Kept open for the whole run, so the stop of PostgreSQL below always reaches it.
      idleTimeoutMillis: 0,
    });
    // The client is terminated (57P01) when a test stops PostgreSQL; the pool reports it as an
    // `error` event, which would otherwise be an uncaught exception.
    migrator.on('error', () => undefined);

    vi.stubEnv('PORT', '3019');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.stubEnv('DATABASE_URL', `postgres://search_app:search_app@127.0.0.1:${postgresPort}/search`);
    vi.stubEnv('NATS_URL', `nats://127.0.0.1:${natsHostPort}`);
    vi.stubEnv('NATS_USER', 'search');
    vi.stubEnv('NATS_PASSWORD', 'search');
    vi.stubEnv('INTERNAL_TOKEN_AUDIENCE', 'search-service');
    vi.stubEnv(
      'INTERNAL_TOKEN_TRUSTED_ISSUERS',
      JSON.stringify({ 'api-gateway': [gateway.publicJwk] }),
    );

    @Module({
      imports: [AppModule],
      controllers: [WiringProbeController],
      providers: [ShutdownGate],
    })
    class ProbedApplicationModule {}

    // As main.ts: the configuration is read inside the start-up, never when a module is imported.
    const config = loadConfig(appConfigSchema);
    app = await createApplication(ProbedApplicationModule, {
      service: 'search-service',
      config,
      internalToken: {
        verifier: {
          audience: config.INTERNAL_TOKEN_AUDIENCE,
          trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
        },
      },
      logDestination: { write: (): void => undefined },
    });
    await app.init();
    signer = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: gateway.privateJwk,
    });
  });

  afterAll(async () => {
    try {
      releaseShutdown();
      await app?.close();
      await migrator.end();
    } finally {
      vi.unstubAllEnvs();
      compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('applies its migration as the migrator role, which owns the platform tables', async () => {
    const tables = await migrator.query<{ tablename: string; tableowner: string }>(
      `select tablename, tableowner from pg_tables where schemaname = 'public' order by tablename`,
    );
    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );

    expect(tables.rows).toEqual(
      [...platformTables, ...rebuildTables].map((tablename) => ({
        tablename,
        tableowner: 'search_migrator',
      })),
    );
    expect(journal.rows).toEqual([{ applied: 7 }]);
  });

  it('applies nothing when the migrator runs again', async () => {
    await runMigrator();

    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: 7 }]);
  });

  it('upgrades an existing platform database while the old application can still use its data', async () => {
    const admin = new pg.Pool({
      connectionString: `postgres://postgres:postgres@127.0.0.1:${postgresPort}/search`,
      max: 1,
    });
    const database = 'search_upgrade_test';
    let owner: pg.Pool | undefined;
    let application: pg.Pool | undefined;
    try {
      await admin.query(`create database ${database} owner search_migrator`);
      owner = new pg.Pool({
        connectionString: `postgres://search_migrator:search_migrator@127.0.0.1:${postgresPort}/${database}`,
        max: 1,
      });
      await owner.query('grant usage on schema public to search_app');
      await owner.query(
        'alter default privileges in schema public grant select, insert, update, delete on tables to search_app',
      );
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      });
      const baseline = migrations[0];
      const rebuild = migrations[1];
      const receipts = migrations[2];
      if (baseline === undefined || rebuild === undefined || receipts === undefined)
        throw new Error('A prior migration is missing.');
      await owner.query('create schema drizzle');
      await owner.query(`create table drizzle.__drizzle_migrations
        (id serial primary key, hash text not null, created_at bigint)`);
      for (const statement of baseline.sql) await owner.query(statement);
      await owner.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [baseline.hash, baseline.folderMillis],
      );
      for (const statement of rebuild.sql) await owner.query(statement);
      await owner.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [rebuild.hash, rebuild.folderMillis],
      );
      for (const statement of receipts.sql) await owner.query(statement);
      await owner.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [receipts.hash, receipts.folderMillis],
      );
      await owner.query('begin');
      await owner.query("select set_config('app.system_access', 'on', true)");
      await owner.query(`insert into search_index_generations
        (id, index_uid, status, broker_at_start)
        values ('01938f6e-0000-7000-8000-000000000095', 'upgrade-before-receipts', 'building', '{}')`);
      await owner.query(
        `insert into search_export_checkpoints (generation_id, source, organization_id, cursor)
        values ('01938f6e-0000-7000-8000-000000000095', 'task', $1, 'prior-cursor')`,
        [atelierNordId],
      );
      await owner.query(
        `insert into search_pending_refreshes
        (generation_id, organization_id, resource_kind, source_id, max_broker_sequence)
        values ('01938f6e-0000-7000-8000-000000000095', $1, 'list', '01938f6e-0000-7000-8000-000000000096', 1)`,
        [atelierNordId],
      );
      await owner.query('commit');

      application = new pg.Pool({
        connectionString: `postgres://search_app:search_app@127.0.0.1:${postgresPort}/${database}`,
        max: 1,
      });
      const oldTenant = new TenantTransactionRunner(application);
      await runWithOrganizationContext(memberOf(atelierNordId), () =>
        oldTenant.run((tx) =>
          tx.client.query(
            `insert into event_versions
          (consumer, organization_id, aggregate_key, version)
          values ('search-service__wiring-probe', $1, 'task:CAD-482', 7)`,
            [atelierNordId],
          ),
        ),
      );

      vi.stubEnv(
        'MIGRATION_DATABASE_URL',
        `postgres://search_migrator:search_migrator@127.0.0.1:${postgresPort}/${database}`,
      );
      try {
        await runMigrator();
      } finally {
        vi.stubEnv(
          'MIGRATION_DATABASE_URL',
          `postgres://search_migrator:search_migrator@127.0.0.1:${postgresPort}/search`,
        );
      }
      const previousData = await runWithOrganizationContext(memberOf(atelierNordId), () =>
        oldTenant.run((tx) =>
          tx.client.query(
            `select version from event_versions where aggregate_key = 'task:CAD-482'`,
          ),
        ),
      );
      expect(previousData.rows).toEqual([{ version: '7' }]);
      await runWithOrganizationContext(memberOf(atelierNordId), () =>
        oldTenant.run((tx) =>
          tx.client.query(
            `update event_versions set version = 8 where aggregate_key = 'task:CAD-482'`,
          ),
        ),
      );
      const journal = await owner.query<{ applied: number }>(
        'select count(*)::int as applied from drizzle.__drizzle_migrations',
      );
      expect(journal.rows).toEqual([{ applied: 7 }]);
      const control = await new SystemTransactionRunner(application).run((tx) =>
        tx.client.query('select id from search_rebuild_control'),
      );
      expect(control.rows).toEqual([{ id: 1 }]);
      const existingGeneration = await new SystemTransactionRunner(application).run((tx) =>
        tx.client.query(
          "select index_uid, status from search_index_generations where index_uid = 'upgrade-before-receipts'",
        ),
      );
      expect(existingGeneration.rows).toEqual([
        { index_uid: 'upgrade-before-receipts', status: 'building' },
      ]);
      const oldCheckpoints = await new SystemTransactionRunner(application).run((tx) =>
        tx.client.query(
          'select cursor, write_token, write_deadline from search_export_checkpoints',
        ),
      );
      expect(oldCheckpoints.rows).toEqual([
        { cursor: 'prior-cursor', write_token: null, write_deadline: null },
      ]);
      const oldRefreshes = await new SystemTransactionRunner(application).run((tx) =>
        tx.client.query('select cascade_phase, cascade_cursor from search_pending_refreshes'),
      );
      expect(oldRefreshes.rows).toEqual([{ cascade_phase: null, cascade_cursor: null }]);
    } finally {
      await application?.end();
      await owner?.end();
      await admin.query(`drop database if exists ${database}`);
      await admin.end();
    }
  });

  it('forces row-level security on the tables that carry an organization', async () => {
    const tables = await migrator.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r'
        order by relname`,
    );
    const policies = await migrator.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname = 'public' order by tablename`,
    );

    expect(tables.rows).toEqual([
      { relname: 'event_versions', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'idempotency_keys', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'outbox_events', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'processed_events', relrowsecurity: false, relforcerowsecurity: false },
      ...rebuildTables.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    ]);
    expect(policies.rows).toEqual([
      { tablename: 'event_versions', policyname: 'event_versions_organization_isolation' },
      { tablename: 'idempotency_keys', policyname: 'idempotency_keys_organization_isolation' },
      { tablename: 'outbox_events', policyname: 'outbox_events_organization_isolation' },
      ...rebuildTables.map((tablename) => ({
        tablename,
        policyname: `${tablename}_system_only`,
      })),
    ]);
  });

  it('reserves rebuild state for system transactions, including the table owner', async () => {
    const system = service().get(SystemTransactionRunner);
    const tenant = service().get(TenantTransactionRunner);
    const generationId = '01938f6e-0000-7000-8000-000000000041';

    await system.run((tx) =>
      tx.client.query(
        `insert into search_index_generations (id, index_uid, status, broker_at_start)
         values ($1, 'atelier-nord-rebuild', 'building', '{}')`,
        [generationId],
      ),
    );
    await system.run((tx) =>
      tx.client.query('insert into search_refresh_receipts (event_id) values ($1)', [
        '01938f6e-0000-7000-8000-000000000094',
      ]),
    );
    try {
      const control = await system.run((tx) =>
        tx.client.query('select id from search_rebuild_control'),
      );
      expect(control.rows).toEqual([{ id: 1 }]);
      for (const table of rebuildTables) {
        const owner = await migrator.query(`select * from ${table}`);
        expect(owner.rows).toEqual([]);
        const tenantRows = await runWithOrganizationContext(memberOf(atelierNordId), () =>
          tenant.run((tx) => tx.client.query(`select * from ${table}`)),
        );
        expect(tenantRows.rows).toEqual([]);
      }
      await expect(
        runWithOrganizationContext(memberOf(atelierNordId), () =>
          tenant.run((tx) =>
            tx.client.query(
              `insert into search_terminal_advisories (stream, stream_created_at, consumer, sequence)
               values ('EVENTS', 'start', 'search', 1)`,
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        migrator.query(
          `insert into search_terminal_advisories (stream, stream_created_at, consumer, sequence)
           values ('EVENTS', 'start', 'search', 1)`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await system.run((tx) =>
        tx.client.query('delete from search_refresh_receipts where event_id = $1', [
          '01938f6e-0000-7000-8000-000000000094',
        ]),
      );
      await system.run((tx) =>
        tx.client.query('delete from search_index_generations where id = $1', [generationId]),
      );
    }
  });

  it('claims only drained generations with recorded engine identities and fences retries', async () => {
    const system = service().get(SystemTransactionRunner);
    const runtime = new DrizzleSearchRuntimeStateRepository(system);
    const ids = [
      '01938f6e-0000-7000-8000-000000000050',
      '01938f6e-0000-7000-8000-000000000051',
      '01938f6e-0000-7000-8000-000000000052',
      '01938f6e-0000-7000-8000-000000000053',
    ];
    const identity = '2026-11-20T19:23:41.749012Z';
    try {
      await system.run(({ client }) =>
        client.query(
          `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start, updated_at)
           values
             ($1, 'stale-active', 'active', $5, '{}', now() - interval '2 hours'),
             ($2, 'fresh-retired', 'retired', $5, '{}', now()),
             ($3, 'unbound-abandoned', 'abandoned', null, '{}', now() - interval '2 hours'),
             ($4, 'drained-retired', 'retired', $5, '{}', now() - interval '2 hours')`,
          [...ids, identity],
        ),
      );
      const claims = await Promise.all([
        runtime.claimExpiredGeneration(),
        runtime.claimExpiredGeneration(),
      ]);
      const claimed = claims.find((entry) => entry !== null);
      expect(claims).toContain(null);
      expect(claimed).toEqual({
        id: ids[3],
        indexUid: 'drained-retired',
        engineCreatedAt: identity,
      });
      if (!claimed) throw new Error('Expected a purge claim.');
      await runtime.markGenerationPurged(claimed);
      const result = await system.run(({ client }) =>
        client.query(
          'select id, purged_at is not null as purged from search_index_generations where id = any($1::uuid[]) order by id',
          [ids],
        ),
      );
      expect(result.rows).toEqual(ids.map((id, index) => ({ id, purged: index === 3 })));
      expect(await runtime.claimExpiredGeneration()).toBeNull();
    } finally {
      await system.run(({ client }) =>
        client.query('delete from search_index_generations where id = any($1::uuid[])', [ids]),
      );
    }
  });

  it('keeps generations, checkpoints and pending refreshes within their rebuild bounds', async () => {
    const system = service().get(SystemTransactionRunner);
    const generationId = '01938f6e-0000-7000-8000-000000000042';
    const run = async (query: string, values: readonly unknown[] = []): Promise<void> => {
      await system.run((tx) => tx.client.query(query, [...values]));
    };
    await run(
      `insert into search_index_generations (id, index_uid, status, broker_at_start)
       values ($1, 'atelier-nord-rebuild-bounds', 'building', '{}')`,
      [generationId],
    );
    try {
      await expect(
        run(`insert into search_index_generations (index_uid, status, broker_at_start)
        values ('other-building', 'building', '{}')`),
      ).rejects.toMatchObject({ code: '23505' });
      await run(`insert into search_index_generations (index_uid, status, broker_at_start)
        values ('active-rebuild-bounds', 'active', '{}')`);
      await expect(
        run(`insert into search_index_generations (index_uid, status, broker_at_start)
        values ('other-active', 'active', '{}')`),
      ).rejects.toMatchObject({ code: '23505' });
      await run(
        `insert into search_export_checkpoints (generation_id, source)
        values ($1, 'organization')`,
        [generationId],
      );
      await expect(
        run(
          `insert into search_export_checkpoints (generation_id, source)
        values ($1, 'organization')`,
          [generationId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        run(
          `insert into search_export_checkpoints (generation_id, source)
        values ($1, 'task')`,
          [generationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        run(
          `insert into search_export_checkpoints (generation_id, source, organization_id, cursor)
        values ($1, 'task', $2, repeat('x', 1025))`,
          [generationId, atelierNordId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await run(
        `insert into search_pending_refreshes
        (generation_id, organization_id, resource_kind, source_id, max_broker_sequence)
        values ($1, $2, 'task', 'CAD-482', 1)`,
        [generationId, atelierNordId],
      );
      await expect(
        run(
          `insert into search_pending_refreshes
        (generation_id, organization_id, resource_kind, source_id, max_broker_sequence)
        values ($1, $2, 'task', 'CAD-483', 0)`,
          [generationId, atelierNordId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        run(
          `update search_pending_refreshes set claim_token = uuidv7()
        where generation_id = $1`,
          [generationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(run('insert into search_rebuild_control (id) values (2)')).rejects.toMatchObject(
        { code: '23514' },
      );
    } finally {
      await run(
        `delete from search_index_generations where id = $1 or index_uid = 'active-rebuild-bounds'`,
        [generationId],
      );
    }
  });

  it('promotes a complete generation atomically and preserves the incumbent while evidence is incomplete', async () => {
    const system = service().get(SystemTransactionRunner);
    const promote = new PromoteSearchRebuild(new DrizzleSearchRebuildPromotionUnitOfWork(system));
    const candidateId = '01938f6e-0000-7000-8000-000000000061';
    const activeId = '01938f6e-0000-7000-8000-000000000062';
    const engineCreatedAt = '2026-11-20T13:05:00.100Z';
    const broker = {
      stream: 'EVENTS',
      createdAt: '2026-11-20T13:00:00.000001Z',
      firstSequence: 1,
      lastSequence: 28,
      retainedGapCount: 0,
      consumers: [
        {
          handler: 'task-updated',
          createdAt: '2026-11-20T13:02:00.000001Z',
          deliveredSequence: 23,
          ackFloorSequence: 23,
          pending: 0,
          ackPending: 0,
        },
      ],
    };
    const input = { generationId: candidateId, engineCreatedAt, broker };
    const run = async (query: string, values: readonly unknown[] = []): Promise<void> => {
      await system.run((tx) => tx.client.query(query, [...values]));
    };
    const states = async (): Promise<unknown[]> => {
      const result = await system.run((tx) =>
        tx.client.query(
          'select id, status, certified_broker_frontier from search_index_generations where id = any($1::uuid[]) order by id',
          [[candidateId, activeId]],
        ),
      );
      return result.rows;
    };
    const unchanged = [
      { id: candidateId, status: 'building', certified_broker_frontier: null },
      { id: activeId, status: 'active', certified_broker_frontier: null },
    ];
    await run(
      `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start)
      values ($1, 'candidate-promotion-test', 'building', $3, $4),
             ($2, 'active-promotion-test', 'active', $3, $4)`,
      [candidateId, activeId, engineCreatedAt, JSON.stringify({ ...broker, lastSequence: 24 })],
    );
    try {
      await run(
        `insert into search_export_checkpoints (generation_id, source, organization_id, complete)
        values ($1, 'organization', null, true), ($1, 'task', $2, true),
          ($1, 'list', $2, true), ($1, 'space', $2, true),
          ($1, 'document', $2, true), ($1, 'storage', $2, true)`,
        [candidateId, atelierNordId],
      );

      await run(
        `insert into search_pending_refreshes (generation_id, organization_id, resource_kind, source_id, max_broker_sequence)
        values ($1, $2, 'task', 'CAD-482', 27)`,
        [candidateId, atelierNordId],
      );
      await expect(promote.execute(input)).rejects.toThrow();
      expect(await states()).toEqual(unchanged);
      await run('delete from search_pending_refreshes where generation_id = $1', [candidateId]);

      await run(
        `insert into search_terminal_advisories (stream, stream_created_at, consumer, sequence)
        values ($1, $2, 'task-updated', 27)`,
        [broker.stream, broker.createdAt],
      );
      await expect(promote.execute(input)).rejects.toThrow();
      expect(await states()).toEqual(unchanged);
      await run(
        'delete from search_terminal_advisories where stream = $1 and stream_created_at = $2',
        [broker.stream, broker.createdAt],
      );

      await run(
        `update search_export_checkpoints set complete = false where generation_id = $1 and source = 'task'`,
        [candidateId],
      );
      await expect(promote.execute(input)).rejects.toThrow();
      expect(await states()).toEqual(unchanged);
      await run(
        `update search_export_checkpoints set complete = true where generation_id = $1 and source = 'task'`,
        [candidateId],
      );

      await run(
        `delete from search_export_checkpoints where generation_id = $1 and source = 'list'`,
        [candidateId],
      );
      await expect(promote.execute(input)).rejects.toThrow();
      expect(await states()).toEqual(unchanged);
      await run(
        `insert into search_export_checkpoints (generation_id, source, organization_id, complete)
        values ($1, 'list', $2, true)`,
        [candidateId, otherOrganizationId],
      );
      await expect(promote.execute(input)).rejects.toThrow();
      expect(await states()).toEqual(unchanged);
      await run(
        `update search_export_checkpoints set organization_id = $2 where generation_id = $1 and source = 'list'`,
        [candidateId, atelierNordId],
      );

      await promote.execute(input);
      expect(await states()).toEqual([
        { id: candidateId, status: 'active', certified_broker_frontier: '28' },
        { id: activeId, status: 'retired', certified_broker_frontier: null },
      ]);
      await promote.execute(input);
      expect(await states()).toEqual([
        { id: candidateId, status: 'active', certified_broker_frontier: '28' },
        { id: activeId, status: 'retired', certified_broker_frontier: null },
      ]);
    } finally {
      await run(
        `delete from search_terminal_advisories where stream = $1 and stream_created_at = $2`,
        [broker.stream, broker.createdAt],
      );
      await run('delete from search_index_generations where id = any($1::uuid[])', [
        [candidateId, activeId],
      ]);
    }
  });

  it('fans out and fences refreshes across concurrent claims and later events', async () => {
    const system = service().get(SystemTransactionRunner);
    const unit = new DrizzleSearchRefreshUnitOfWork(system);
    const record = new RecordSearchRefreshes(unit);
    const active = '01938f6e-0000-7000-8000-000000000071';
    const building = '01938f6e-0000-7000-8000-000000000072';
    const retired = '01938f6e-0000-7000-8000-000000000073';
    const firstToken = '01938f6e-0000-7000-8000-000000000081';
    const secondToken = '01938f6e-0000-7000-8000-000000000082';
    const firstEvent = '01938f6e-0000-7000-8000-000000000091';
    const secondEvent = '01938f6e-0000-7000-8000-000000000092';
    const failedEvent = '01938f6e-0000-7000-8000-000000000093';
    const target = { organizationId: atelierNordId, kind: 'task' as const, sourceId: 'CAD-482' };
    const deadline = new Date('2020-01-01T00:00:00Z');
    const run = async (query: string, values: readonly unknown[] = []): Promise<void> => {
      await system.run((tx) => tx.client.query(query, [...values]));
    };
    const rows = async (): Promise<unknown[]> => {
      const result = await system.run((tx) =>
        tx.client.query(
          `select generation_id, max_broker_sequence, revision, claim_token
           from search_pending_refreshes where generation_id = any($1::uuid[])
          order by generation_id`,
          [[active, building, retired]],
        ),
      );
      return result.rows;
    };
    await run(
      `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start)
      values ($1, 'queue-active', 'active', 'engine-one', '{}'),
        ($2, 'queue-building', 'building', 'engine-two', '{}'),
        ($3, 'queue-retired', 'retired', 'engine-three', '{}')`,
      [active, building, retired],
    );
    try {
      await record.execute({ eventId: firstEvent, brokerSequence: 10, targets: [target, target] });
      await record.execute({ eventId: firstEvent, brokerSequence: 10, targets: [target] });
      expect(await rows()).toEqual([
        { generation_id: active, max_broker_sequence: '10', revision: '1', claim_token: null },
        { generation_id: building, max_broker_sequence: '10', revision: '1', claim_token: null },
      ]);
      const claims = await Promise.all([
        unit.run((tx) => tx.claimNext(active, firstToken, deadline)),
        unit.run((tx) => tx.claimNext(active, secondToken, deadline)),
      ]);
      const claim = claims.find((item) => item !== null);
      expect(claims.filter((item) => item !== null)).toHaveLength(1);
      if (claim === undefined) throw new Error('No refresh was claimed.');
      expect(claim.revision).toBe(1);
      expect(await unit.run((tx) => tx.claimNext(active, secondToken, deadline))).toBeNull();

      await record.execute({ eventId: secondEvent, brokerSequence: 11, targets: [target] });
      await record.execute({ eventId: secondEvent, brokerSequence: 11, targets: [target] });
      await unit.run((tx) =>
        tx.finish({ ...claim, token: '01938f6e-0000-7000-8000-000000000083' }, 'applied'),
      );
      expect((await rows())[0]).toEqual({
        generation_id: active,
        max_broker_sequence: '11',
        revision: '2',
        claim_token: claim.token,
      });
      await unit.run((tx) => tx.finish(claim, 'applied'));
      expect((await rows())[0]).toEqual({
        generation_id: active,
        max_broker_sequence: '11',
        revision: '2',
        claim_token: null,
      });

      const latest = await unit.run((tx) => tx.claimNext(active, secondToken, deadline));
      expect(latest).toMatchObject({ revision: 2, token: secondToken });
      if (latest === null) throw new Error('No updated refresh was claimed.');
      await unit.run((tx) => tx.finish(latest, 'released'));
      const retry = await unit.run((tx) => tx.claimNext(active, firstToken, deadline));
      expect(retry).toMatchObject({ revision: 2, token: firstToken });
      if (retry === null) throw new Error('The released refresh was not claimable.');
      await unit.run((tx) => tx.finish(retry, 'applied'));
      expect(await rows()).toEqual([
        { generation_id: building, max_broker_sequence: '11', revision: '2', claim_token: null },
      ]);

      const buildingClaim = await unit.run((tx) => tx.claimNext(building, secondToken, deadline));
      if (buildingClaim === null) throw new Error('The building generation refresh is missing.');
      await unit.run((tx) => tx.finish(buildingClaim, 'applied'));
      await record.execute({ eventId: firstEvent, brokerSequence: 10, targets: [target] });
      await record.execute({ eventId: secondEvent, brokerSequence: 11, targets: [target] });
      expect(await rows()).toEqual([]);

      await expect(
        record.execute({
          eventId: failedEvent,
          brokerSequence: 12,
          targets: [{ ...target, sourceId: 'x'.repeat(513) }],
        }),
      ).rejects.toThrow();
      const failedReceipt = await system.run((tx) =>
        tx.client.query('select event_id from search_refresh_receipts where event_id = $1', [
          failedEvent,
        ]),
      );
      expect(failedReceipt.rows).toEqual([]);
      expect(await rows()).toEqual([]);

      await run(
        `insert into search_pending_refreshes (generation_id, organization_id, resource_kind, source_id, max_broker_sequence)
        values ($1, $3, 'task', 'CAD-482', 11),
          ($2, $3, 'document', 'document-unavailable', 12),
          ($2, $3, 'task', 'CAD-483', 13)`,
        [retired, active, atelierNordId],
      );
      expect(await unit.run((tx) => tx.claimNext(retired, firstToken, deadline))).toBeNull();
      const unavailable = await unit.run((tx) => tx.claimNext(active, firstToken, deadline));
      if (!unavailable) throw new Error('The unavailable document was not claimed.');
      expect(unavailable.sourceId).toBe('document-unavailable');
      await unit.run((tx) => tx.finish(unavailable, 'released', new Date(Date.now() + 60_000)));
      const healthy = await unit.run((tx) => tx.claimNext(active, secondToken, deadline));
      if (!healthy) throw new Error('The healthy task was not claimed.');
      expect(healthy.sourceId).toBe('CAD-483');
      await unit.run((tx) => tx.finish(healthy, 'applied'));
      expect(await unit.run((tx) => tx.claimNext(active, secondToken, deadline))).toBeNull();
      await run(
        `update search_pending_refreshes set next_attempt_at = now() - interval '1 second'
        where generation_id = $1 and source_id = 'document-unavailable'`,
        [active],
      );
      expect(await unit.run((tx) => tx.claimNext(active, secondToken, deadline))).toMatchObject({
        sourceId: 'document-unavailable',
      });
    } finally {
      await run('delete from search_refresh_receipts where event_id = any($1::uuid[])', [
        [firstEvent, secondEvent, failedEvent],
      ]);
      await run('delete from search_index_generations where id = any($1::uuid[])', [
        [active, building, retired],
      ]);
    }
  });

  it('serializes tenant export intents and never takes over an expired physical write', async () => {
    const system = service().get(SystemTransactionRunner);
    const unit = new DrizzleSearchRebuildExportUnitOfWork(system);
    const claimPage = new ClaimSearchExportPage(unit);
    const generationId = '01938f6e-0000-7000-8000-000000000101';
    const token = '01938f6e-0000-7000-8000-000000000102';
    const otherToken = '01938f6e-0000-7000-8000-000000000103';
    const run = async (query: string, values: readonly unknown[] = []): Promise<void> => {
      await system.run((tx) => tx.client.query(query, [...values]));
    };
    const claim = {
      generationId,
      organizationId: atelierNordId,
      source: 'task' as const,
      expectedCursor: null,
      claimToken: token,
      claimedAt: new Date(),
      claimDeadline: new Date(Date.now() + 60_000),
    };
    await run(
      `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start)
      values ($1, 'export-intent-test', 'building', 'engine', '{}')`,
      [generationId],
    );
    try {
      await run(
        `insert into search_export_checkpoints (generation_id, source, organization_id)
        values ($1, 'organization', null), ($1, 'task', $2), ($1, 'list', $2)`,
        [generationId, atelierNordId],
      );
      await expect(
        run(
          `update search_export_checkpoints set write_token = $2
        where generation_id = $1 and source = 'task'`,
          [generationId, token],
        ),
      ).rejects.toThrow();
      await expect(
        run(
          `update search_export_checkpoints set write_token = $2, write_deadline = now() + interval '1 minute'
        where generation_id = $1 and source = 'organization'`,
          [generationId, token],
        ),
      ).rejects.toThrow();
      await expect(
        run(
          `update search_export_checkpoints set complete = true, write_token = $2, write_deadline = now() + interval '1 minute'
        where generation_id = $1 and source = 'list'`,
          [generationId, token],
        ),
      ).rejects.toThrow();

      expect(await claimPage.execute({ ...claim, expectedCursor: 'wrong' })).toBe('stale');
      const claims = await Promise.all([
        claimPage.execute(claim),
        claimPage.execute({ ...claim, claimToken: otherToken }),
      ]);
      expect([...claims].sort()).toEqual(['claimed', 'occupied']);
      const winner = claims[0] === 'claimed' ? token : otherToken;
      const loser = winner === token ? otherToken : token;
      expect(
        await unit.run((tx) =>
          tx.recordExportPage({ ...claim, claimToken: loser, nextCursor: 'page-two' }),
        ),
      ).toBe('stale');
      expect(
        await unit.run((tx) =>
          tx.recordExportPage({ ...claim, claimToken: winner, nextCursor: 'page-two' }),
        ),
      ).toBe('applied');
      expect(await claimPage.execute({ ...claim, expectedCursor: 'page-two' })).toBe('claimed');
      await run(
        `update search_export_checkpoints set write_deadline = now() - interval '1 second'
        where generation_id = $1 and source = 'task'`,
        [generationId],
      );
      expect(
        await claimPage.execute({ ...claim, expectedCursor: 'page-two', claimToken: otherToken }),
      ).toBe('expired');
      expect(
        await unit.run((tx) =>
          tx.recordExportPage({ ...claim, expectedCursor: 'page-two', nextCursor: null }),
        ),
      ).toBe('stale');
    } finally {
      await run('delete from search_index_generations where id = $1', [generationId]);
    }
  });

  it('selects a ready export behind a deferred one without treating deferred exports as complete', async () => {
    const system = service().get(SystemTransactionRunner);
    const generations = new DrizzleSearchGenerationUnitOfWork(system);
    const exports = new DrizzleSearchRebuildExportUnitOfWork(system);
    const generationId = '01938f6e-0000-7000-8000-000000000104';
    const run = async (query: string, values: readonly unknown[]): Promise<void> => {
      await system.run((tx) => tx.client.query(query, [...values]));
    };
    await run(
      `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start)
      values ($1, 'export-retry-test', 'building', 'engine', '{}')`,
      [generationId],
    );
    try {
      await run(
        `insert into search_export_checkpoints (generation_id, source, organization_id, complete)
        values ($1, 'organization', null, true), ($1, 'document', $2, false), ($1, 'task', $2, false)`,
        [generationId, atelierNordId],
      );
      const next = () => generations.run((tx) => tx.nextCheckpoint(generationId));
      const failed = await next();
      if (!failed) throw new Error('The failed export position was not selected.');
      expect(failed).toMatchObject({ source: 'document', deferred: false });
      await exports.run((tx) =>
        tx.deferCheckpoint(generationId, failed, new Date(Date.now() + 60_000)),
      );
      expect(await next()).toMatchObject({ source: 'task', deferred: false });
      await run(
        "update search_export_checkpoints set complete = true where generation_id = $1 and source = 'task'",
        [generationId],
      );
      expect(await next()).toMatchObject({ source: 'document', deferred: true });
      await run(
        `update search_export_checkpoints set next_attempt_at = now() - interval '1 second'
        where generation_id = $1 and source = 'document'`,
        [generationId],
      );
      expect(await next()).toMatchObject({ source: 'document', deferred: false });
    } finally {
      await run('delete from search_index_generations where id = $1', [generationId]);
    }
  });

  it('abandons only when a rejected continuation still matches unclaimed work', async () => {
    const system = service().get(SystemTransactionRunner);
    const generations = new DrizzleSearchGenerationUnitOfWork(system);
    const generationId = '01938f6e-0000-7000-8000-000000000105';
    const claimToken = '01938f6e-0000-7000-8000-000000000106';
    const run = async (query: string, values: readonly unknown[]): Promise<void> => {
      await system.run((tx) => tx.client.query(query, [...values]));
    };
    await run(
      `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start)
      values ($1, 'stale-export-failure-test', 'building', 'engine', '{}')`,
      [generationId],
    );
    try {
      await run(
        `insert into search_export_checkpoints
          (generation_id, source, organization_id, cursor, complete, write_token, write_deadline)
        values ($1, 'organization', null, null, true, null, null),
               ($1, 'document', $2, 'next-page', false, $3, now() + interval '30 seconds')`,
        [generationId, atelierNordId, claimToken],
      );
      const reject = (cursor: string) =>
        generations.run((tx) =>
          tx.abandon(generationId, {
            source: 'document',
            organizationId: atelierNordId,
            cursor,
            deferred: false,
            inFlightDeadline: null,
          }),
        );
      expect(await reject('next-page')).toBe(false);
      await run(
        'update search_export_checkpoints set write_token = null, write_deadline = null where write_token = $1',
        [claimToken],
      );
      expect(await reject('old-page')).toBe(false);
      expect(await generations.run((tx) => tx.findBuilding())).toMatchObject({ id: generationId });
      expect(await reject('next-page')).toBe(true);
      expect(await generations.run((tx) => tx.findBuilding())).toBeNull();
    } finally {
      await run('delete from search_index_generations where id = $1', [generationId]);
    }
  });

  it('commits parent progress with child invalidations and restarts after a newer parent revision', async () => {
    const system = service().get(SystemTransactionRunner);
    const parent = new DrizzleSearchParentReconciliation(system);
    const generationId = '01938f6e-0000-7000-8000-000000000111';
    const listId = '01938f6e-0000-7000-8000-000000000112';
    const token = '01938f6e-0000-7000-8000-000000000113';
    const run = async (query: string, values: readonly unknown[] = []): Promise<void> => {
      await system.run((tx) => tx.client.query(query, [...values]));
    };
    await run(
      `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start)
      values ($1, 'parent-cascade-test', 'building', 'engine', '{}')`,
      [generationId],
    );
    try {
      await run(
        `insert into search_pending_refreshes (generation_id, organization_id, resource_kind, source_id, max_broker_sequence)
        values ($1, $2, 'list', $3, 17)`,
        [generationId, atelierNordId, listId],
      );
      await expect(
        run(
          `update search_pending_refreshes set cascade_phase = 'lists'
        where generation_id = $1`,
          [generationId],
        ),
      ).rejects.toThrow();
      await expect(
        run(
          `update search_pending_refreshes set cascade_phase = 'self', cascade_cursor = 'invalid'
        where generation_id = $1`,
          [generationId],
        ),
      ).rejects.toThrow();
      await expect(
        run(
          `update search_pending_refreshes set cascade_phase = 'tasks', cascade_cursor = repeat('x', 1025)
        where generation_id = $1`,
          [generationId],
        ),
      ).rejects.toThrow();
      const first = await parent.claimNextParent(
        generationId,
        token,
        new Date(Date.now() + 60_000),
      );
      if (first === null) throw new Error('The parent refresh is missing.');
      expect(first.checkpoint).toEqual({ phase: 'indexed', cursor: null });
      const child = { organizationId: atelierNordId, kind: 'task' as const, sourceId: 'CAD-482' };
      await expect(
        parent.advance({
          claim: first.claim,
          expected: first.checkpoint,
          next: { phase: 'tasks', cursor: 'page-two' },
          children: [child, { ...child, sourceId: 'x'.repeat(513) }],
        }),
      ).rejects.toThrow();
      const afterFailure = await system.run((tx) =>
        tx.client.query(
          `select resource_kind, cascade_phase, cascade_cursor, claim_token
        from search_pending_refreshes where generation_id = $1`,
          [generationId],
        ),
      );
      expect(afterFailure.rows).toEqual([
        {
          resource_kind: 'list',
          cascade_phase: 'indexed',
          cascade_cursor: null,
          claim_token: token,
        },
      ]);
      expect(
        await parent.advance({
          claim: first.claim,
          expected: first.checkpoint,
          next: { phase: 'tasks', cursor: 'page-two' },
          children: [child],
        }),
      ).toBe('advanced');
      const afterPage = await system.run((tx) =>
        tx.client.query(
          `select resource_kind, source_id, cascade_phase, cascade_cursor
        from search_pending_refreshes where generation_id = $1 order by resource_kind`,
          [generationId],
        ),
      );
      expect(afterPage.rows).toEqual([
        {
          resource_kind: 'list',
          source_id: listId,
          cascade_phase: 'tasks',
          cascade_cursor: 'page-two',
        },
        { resource_kind: 'task', source_id: 'CAD-482', cascade_phase: null, cascade_cursor: null },
      ]);
      const second = await parent.claimNextParent(
        generationId,
        token,
        new Date(Date.now() + 60_000),
      );
      if (second === null) throw new Error('The parent continuation is missing.');
      await run(
        `update search_pending_refreshes set revision = revision + 1, max_broker_sequence = 18
        where generation_id = $1 and resource_kind = 'list'`,
        [generationId],
      );
      expect(
        await parent.advance({
          claim: second.claim,
          expected: second.checkpoint,
          next: { phase: 'self', cursor: null },
          children: [{ ...child, sourceId: 'CAD-483' }],
        }),
      ).toBe('restarted');
      const restarted = await system.run((tx) =>
        tx.client.query(
          `select resource_kind, source_id, cascade_phase, cascade_cursor, claim_token
        from search_pending_refreshes where generation_id = $1 order by resource_kind`,
          [generationId],
        ),
      );
      expect(restarted.rows).toEqual([
        {
          resource_kind: 'list',
          source_id: listId,
          cascade_phase: 'indexed',
          cascade_cursor: null,
          claim_token: null,
        },
        {
          resource_kind: 'task',
          source_id: 'CAD-482',
          cascade_phase: null,
          cascade_cursor: null,
          claim_token: null,
        },
      ]);
    } finally {
      await run('delete from search_index_generations where id = $1', [generationId]);
    }
  });

  it('prunes old refresh receipts in bounded batches while keeping recent deliveries', async () => {
    const system = service().get(SystemTransactionRunner);
    const repository = new DrizzleSearchRuntimeStateRepository(system);
    const inserted = await system.run((tx) =>
      tx.client.query(
        `insert into search_refresh_receipts (event_id, processed_at)
       select uuidv7(), now() - interval '46 days' from generate_series(1, 1001)
       union all select uuidv7(), now() - interval '44 days'
       returning event_id`,
      ),
    );
    const ids = (inserted.rows as readonly { readonly event_id: string }[]).map(
      (row) => row.event_id,
    );
    try {
      expect(await repository.pruneReceipts()).toBe(1000);
      const afterFirst = await system.run((tx) =>
        tx.client.query(
          'select count(*)::int as count from search_refresh_receipts where event_id = any($1::uuid[])',
          [ids],
        ),
      );
      expect(afterFirst.rows).toEqual([{ count: 2 }]);
      expect(await repository.pruneReceipts()).toBe(1);
      const recent = await system.run((tx) =>
        tx.client.query(
          `select count(*)::int as count from search_refresh_receipts
         where event_id = any($1::uuid[]) and processed_at > now() - interval '45 days'`,
          [ids],
        ),
      );
      expect(recent.rows).toEqual([{ count: 1 }]);
      expect(await repository.pruneReceipts()).toBe(0);
    } finally {
      await system.run((tx) =>
        tx.client.query('delete from search_refresh_receipts where event_id = any($1::uuid[])', [
          ids,
        ]),
      );
    }
  });

  it('answers the liveness probe without a token', async () => {
    const response = await request(service().getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('is ready once PostgreSQL answers the application role and NATS the search user', async () => {
    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      details: { postgres: { status: 'up' }, nats: { status: 'up' } },
    });
  });

  it('refuses a route of the application without an internal token', async () => {
    const response = await request(service().getHttpServer()).get('/internal/v1/wiring-probe');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
    expect(response.body).toMatchObject({ status: 401, code: 'auth.token-missing' });
  });

  it('serves a route to a trusted issuer acting for a member of the organization', async () => {
    const token = await signer.sign('search-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reached: true });
  });

  it('refuses a token signed for another service', async () => {
    const token = await signer.sign('document-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'auth.token-invalid',
      details: { reason: 'audience' },
    });
  });

  it('lets the application role read and write the platform tables of its organization only', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const countAll = async (organizationId: string): Promise<Record<string, number>> =>
      runWithOrganizationContext(memberOf(organizationId), () =>
        tenant.run(async (tx) => {
          const counts = await tx.client.query(
            `select 'outbox_events' as name, count(*)::int as rows from outbox_events
             union all select 'event_versions', count(*)::int from event_versions
             union all select 'idempotency_keys', count(*)::int from idempotency_keys`,
          );
          const rows = counts.rows as readonly { readonly name: string; readonly rows: number }[];
          return Object.fromEntries(rows.map(({ name, rows: count }) => [name, count]));
        }),
      );

    // Sent rather than pending: the relay must have nothing to publish, and the `search` user may
    // publish nothing.
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        await tx.client.query(
          `insert into outbox_events
             (id, event_name, subject, stream, organization_id, payload, status, sent_at)
           values (uuidv7(), 'search.wiring-probe.v1', 'evt.search.wiring-probe.v1',
                   'EVENTS', $1, '{}', 'sent', now())`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into event_versions (consumer, organization_id, aggregate_key, version)
           values ('search-service__wiring-probe', $1, 'task:CAD-482', 1)`,
          [atelierNordId],
        );
        await tx.client.query(
          `update event_versions set version = 2 where aggregate_key = 'task:CAD-482'`,
        );
        await tx.client.query(
          `insert into idempotency_keys
             (organization_id, key, request_fingerprint, response_status, response_headers,
              expires_at)
           values ($1, 'wiring-probe', 'fingerprint', 201, '{}', now() + interval '1 day')`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into processed_events (consumer, event_id)
           values ('search-service__wiring-probe', uuidv7())`,
        );
      }),
    );

    expect(await countAll(atelierNordId)).toEqual({
      outbox_events: 1,
      event_versions: 1,
      idempotency_keys: 1,
    });
    expect(await countAll(otherOrganizationId)).toEqual({
      outbox_events: 0,
      event_versions: 0,
      idempotency_keys: 0,
    });
    await expect(
      runWithOrganizationContext(memberOf(otherOrganizationId), () =>
        tenant.run((tx) =>
          tx.client.query(
            `insert into event_versions (consumer, organization_id, aggregate_key, version)
             values ('search-service__wiring-probe', $1, 'task:CAD-483', 1)`,
            [atelierNordId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const deleted = await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        const counts: number[] = [];
        for (const table of platformTables) {
          counts.push((await tx.client.query(`delete from ${table} returning 1`)).rows.length);
        }
        return counts;
      }),
    );
    expect(deleted).toEqual([1, 1, 1, 1]);
  });

  it('refuses any change of structure to the application role', async () => {
    const system = service().get(SystemTransactionRunner);
    const statements = [
      'create table wiring_probe (id integer)',
      'alter table outbox_events add column wiring_probe integer',
      'alter table outbox_events no force row level security',
      'drop table processed_events',
      'truncate idempotency_keys',
      'create schema wiring_probe',
    ];

    for (const statement of statements) {
      await expect(system.run((tx) => tx.client.query(statement))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('keeps the application role out of the journal of the migrations', async () => {
    const system = service().get(SystemTransactionRunner);

    // A rewritten journal would make the next migration run apply migrations again.
    await expect(
      system.run((tx) => tx.client.query('delete from drizzle.__drizzle_migrations')),
    ).rejects.toMatchObject({ code: '42501', message: 'permission denied for schema drizzle' });
    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: 7 }]);
  });

  it('redelivers a Search event after rollback and acknowledges it after its refresh commits', async () => {
    const system = service().get(SystemTransactionRunner);
    const eventId = '01938f6e-0000-7000-8000-000000000096';
    const generationId = '01938f6e-0000-7000-8000-000000000097';
    const event = {
      id: eventId,
      organizationId: atelierNordId,
      actor: { type: 'system', id: 'test-fixture' },
      occurredAt: '2026-05-15T12:00:00.000Z',
      version: 4,
      key: 'CAD-482',
      entryId: '01938f6e-0000-7000-8000-000000000098',
      rootKey: 'CAD-482',
      parentKey: null,
      listId: '01938f6e-0000-7000-8000-000000000099',
      spaceId: '01938f6e-0000-7000-8000-000000000100',
    };
    let consumerApp: NestExpressApplication | undefined;
    await system.run(({ client }) =>
      client.query(
        `insert into search_index_generations (id, index_uid, status, engine_created_at, broker_at_start)
         values ($1, 'event-redelivery', 'active', 'engine', '{}')`,
        [generationId],
      ),
    );
    try {
      vi.stubEnv('MEILI_URL', 'http://127.0.0.1:7700');
      vi.stubEnv('MEILI_API_KEY', 'synthetic-test-key');
      vi.stubEnv('INTERNAL_TOKEN_PRIVATE_JWK', JSON.stringify(gateway.privateJwk));
      for (const key of [
        'TASK_SERVICE_URL',
        'ORGANIZATION_SERVICE_URL',
        'DOCUMENT_SERVICE_URL',
        'STORAGE_SERVICE_URL',
      ]) {
        vi.stubEnv(key, 'http://127.0.0.1:3019');
      }
      const config = loadConfig(appConfigSchema);
      consumerApp = await createApplication(AppModule, {
        service: 'search-service',
        config,
        internalToken: {
          verifier: {
            audience: config.INTERNAL_TOKEN_AUDIENCE,
            trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
          },
        },
        logDestination: { write: (): void => undefined },
      });
      await consumerApp.init();
      await migrator.query('revoke insert on search_pending_refreshes from search_app');
      compose(
        'exec',
        '-T',
        'nats-streams',
        'nats',
        'pub',
        'evt.task.purged.v1',
        JSON.stringify(event),
      );
      await vi.waitFor(
        () => {
          const info = JSON.parse(
            compose(
              'exec',
              '-T',
              'nats-streams',
              'nats',
              'consumer',
              'info',
              'EVENTS',
              'search-service__index-task-purged-v1',
              '--json',
            ),
          ) as { readonly num_redelivered: number };
          expect(info.num_redelivered).toBeGreaterThan(0);
        },
        { timeout: 30_000, interval: 250 },
      );
      const rolledBack = await system.run(({ client }) =>
        client.query('select event_id from search_refresh_receipts where event_id = $1', [eventId]),
      );
      expect(rolledBack.rows).toEqual([]);
      await migrator.query('grant insert on search_pending_refreshes to search_app');
      await vi.waitFor(
        async () => {
          const queued = await system.run(({ client }) =>
            client.query(
              'select source_id, revision from search_pending_refreshes where generation_id = $1',
              [generationId],
            ),
          );
          expect(queued.rows).toEqual([{ source_id: 'CAD-482', revision: '1' }]);
          const receipt = await system.run(({ client }) =>
            client.query('select event_id from search_refresh_receipts where event_id = $1', [
              eventId,
            ]),
          );
          expect(receipt.rows).toEqual([{ event_id: eventId }]);
          const info = JSON.parse(
            compose(
              'exec',
              '-T',
              'nats-streams',
              'nats',
              'consumer',
              'info',
              'EVENTS',
              'search-service__index-task-purged-v1',
              '--json',
            ),
          ) as { readonly num_ack_pending: number; readonly num_pending: number };
          expect(info.num_ack_pending).toBe(0);
          expect(info.num_pending).toBe(0);
        },
        { timeout: 30_000, interval: 250 },
      );
    } finally {
      await migrator.query('grant insert on search_pending_refreshes to search_app');
      await consumerApp?.close();
      await system.run(({ client }) =>
        client.query('delete from search_refresh_receipts where event_id = $1', [eventId]),
      );
      await system.run(({ client }) =>
        client.query('delete from search_index_generations where id = $1', [generationId]),
      );
      for (const key of [
        'MEILI_URL',
        'MEILI_API_KEY',
        'INTERNAL_TOKEN_PRIVATE_JWK',
        'TASK_SERVICE_URL',
        'ORGANIZATION_SERVICE_URL',
        'DOCUMENT_SERVICE_URL',
        'STORAGE_SERVICE_URL',
      ])
        vi.stubEnv(key, undefined);
    }
  }, 90_000);

  it('runs against a broker that enforces the permissions of cadenway-ops', () => {
    const search = { NATS_USER: 'search', NATS_PASSWORD: 'search' };

    expect(
      brokerAccepts(search, '--inbox-prefix', '_INBOX.search', 'stream', 'info', 'EVENTS'),
    ).toBe(true);
    expect(brokerAccepts(search, 'stream', 'info', 'EVENTS')).toBe(false);
    expect(brokerAccepts(search, 'pub', 'evt.search.wiring-probe', 'refused')).toBe(false);
    expect(brokerAccepts({ NATS_USER: '', NATS_PASSWORD: '' }, 'pub', 'evt.search.x', 'x')).toBe(
      false,
    );
  });

  it('stops being ready while NATS is down, and is ready again once it is back', async () => {
    compose('stop', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          status: 'error',
          info: { postgres: { status: 'up' } },
          error: { nats: { status: 'down' } },
        });
      },
      { timeout: 10_000, interval: 250 },
    );

    compose('start', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(200);
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it('stops being ready when its database is down', async () => {
    compose('stop', 'postgres');

    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'error',
      error: { postgres: { status: 'down' } },
    });
  });

  it('answers 503 on readiness and 200 on liveness as soon as it shuts down', async () => {
    const running = service();
    const closing = running.close();

    await vi.waitFor(
      async () => {
        const response = await request(running.getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          error: { shutdown: { status: 'down', message: 'shutting down' } },
        });
      },
      { timeout: 5_000, interval: 50 },
    );
    const live = await request(running.getHttpServer()).get('/health/live');
    expect(live.status).toBe(200);

    releaseShutdown();
    await closing;
    app = undefined;
  });
});
