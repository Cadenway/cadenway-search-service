import { baseConfigShape, internalTokenVerifierConfigShape } from '@cadenway/nest-common';
import type { BaseConfig, InternalTokenVerifierConfig } from '@cadenway/nest-common';
import { databaseConfigShape } from '@cadenway/nest-common/database';
import type { DatabaseConfig } from '@cadenway/nest-common/database';
import { messagingConfigShape } from '@cadenway/nest-messaging';
import type { MessagingConfig } from '@cadenway/nest-messaging';
import { z } from 'zod';

/**
 * Type AppConfig
 *
 * @description
 * Variables the running service reads, validated when the application is created: by `loadConfig`
 * in `main.ts` for the options of `createApplication`, and by `ConfigModule` for the providers that
 * inject `CONFIG`.
 *
 * - `NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`: `baseConfigShape` of `@cadenway/nest-common`;
 *   `PORT` is required, the others default to `production`, `info` and `false`.
 * - `DATABASE_URL`: the application role of this service's own database (`search_app`),
 *   subject to row-level security and holding no DDL right.
 * - `DATABASE_TRANSACTION_MAX_ATTEMPTS`: total attempts for an outer PostgreSQL transaction.
 *   Defaults to 3. Set it to 1 to disable automatic retries.
 * - `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`: `messagingConfigShape` of `@cadenway/nest-messaging`.
 *   `NATS_URL` is required; the user (`search`) and its password are optional for the kit,
 *   which accepts an anonymous local broker, but every broker of Cadenway refuses a connection
 *   without them.
 * - `INTERNAL_TOKEN_AUDIENCE` and `INTERNAL_TOKEN_TRUSTED_ISSUERS`: the `aud` this service accepts
 *   and the public keys of the backends allowed to call it.
 * - `MEILI_URL` and `MEILI_API_KEY`: the HTTP endpoint and API key for Meilisearch. Both are
 *   required when Meilisearch is configured and optional together.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is read by `telemetry.ts`, before the application exists.
 */
export type AppConfig = BaseConfig &
  DatabaseConfig &
  MessagingConfig &
  InternalTokenVerifierConfig & {
    readonly MEILI_URL?: string;
    readonly MEILI_API_KEY?: string;
  };

/**
 * Constant appConfigSchema
 *
 * @description
 * Zod schema of `AppConfig`, composed from the shapes of `@cadenway/nest-common` and
 * `@cadenway/nest-messaging` so the names, defaults and validation stay those of the kit. A missing
 * or invalid variable makes `loadConfig` throw a `ConfigError` that names it without printing its
 * value.
 *
 * @type {z.ZodType<AppConfig>}
 */
export const appConfigSchema: z.ZodType<AppConfig> = z
  .object({
    ...baseConfigShape,
    ...databaseConfigShape,
    ...messagingConfigShape,
    ...internalTokenVerifierConfigShape,
    MEILI_URL: z
      .string()
      .refine((value): boolean => {
        const endpoint = URL.parse(value);
        return (
          endpoint !== null &&
          /^https?:\/\//iu.test(value) &&
          endpoint.username === '' &&
          endpoint.password === '' &&
          !/[?#]/u.test(value)
        );
      }, 'Expected a Meilisearch HTTP(S) URL without credentials, query or fragment.')
      .optional(),
    MEILI_API_KEY: z
      .string()
      .regex(/^[!-~]+$/u, 'Expected a Meilisearch API key made of visible ASCII characters.')
      .optional(),
  })
  .superRefine((config, ctx): void => {
    const hasUrl = config.MEILI_URL !== undefined;
    const hasKey = config.MEILI_API_KEY !== undefined;
    if (hasUrl !== hasKey) {
      ctx.addIssue({
        code: 'custom',
        path: [hasUrl ? 'MEILI_API_KEY' : 'MEILI_URL'],
        message: 'Configure both Meilisearch variables together.',
      });
    }
  });

/**
 * Interface MigrationConfig
 *
 * @description
 * Variable the one-off migration container reads (`node dist/migrate.js`). The running service
 * never reads it: only the migrator role may change the structure of the database.
 */
export interface MigrationConfig {
  // #region Properties
  /**
   * Property MIGRATION_DATABASE_URL
   *
   * @description
   * Connection string of the migrator role (`search_migrator`), which owns the tables and runs the
   * DDL. A secret; cadenway-ops passes it from `SEARCH_SERVICE_MIGRATION_DATABASE_URL`.
   *
   * @type {string}
   * @readonly
   */
  readonly MIGRATION_DATABASE_URL: string;
  // #endregion
}

/**
 * Constant migrationConfigSchema
 *
 * @description
 * Zod schema of `MigrationConfig`: a `postgres://` or `postgresql://` URL, like `DATABASE_URL`.
 *
 * @type {z.ZodType<MigrationConfig>}
 */
export const migrationConfigSchema: z.ZodType<MigrationConfig> = z.object({
  MIGRATION_DATABASE_URL: z.url({
    protocol: /^postgres(?:ql)?$/u,
    error: 'Expected the postgres:// URL of the migrator role.',
  }),
});
