import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { ConfigError, loadConfig } from '@cadenway/nest-common';
import { describe, expect, it } from 'vitest';

import { appConfigSchema, migrationConfigSchema } from './app-config.js';

describe('appConfigSchema', () => {
  const trustedIssuers: string =
    '{"api-gateway":[{"kty":"OKP","crv":"Ed25519","x":"MVZQc5h6AXxnMpaBTaYw5kI-yWWawl6zp8Srhuf5NK0","kid":"local-placeholder"}]}';
  const complete: Readonly<Record<string, string>> = {
    PORT: '3019',
    DATABASE_URL: 'postgres://search_app:search_app@localhost:5432/search',
    NATS_URL: 'nats://localhost:4222',
    NATS_USER: 'search',
    NATS_PASSWORD: 'search',
    INTERNAL_TOKEN_AUDIENCE: 'search-service',
    INTERNAL_TOKEN_TRUSTED_ISSUERS: trustedIssuers,
  };

  it('reads the variables of the service with the defaults of the kit', () => {
    expect(loadConfig(appConfigSchema, complete)).toEqual({
      NODE_ENV: 'production',
      PORT: 3019,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      DATABASE_URL: 'postgres://search_app:search_app@localhost:5432/search',
      DATABASE_TRANSACTION_MAX_ATTEMPTS: 3,
      NATS_URL: 'nats://localhost:4222',
      NATS_USER: 'search',
      NATS_PASSWORD: 'search',
      INTERNAL_TOKEN_AUDIENCE: 'search-service',
      INTERNAL_TOKEN_TRUSTED_ISSUERS: {
        'api-gateway': [
          {
            kty: 'OKP',
            crv: 'Ed25519',
            x: 'MVZQc5h6AXxnMpaBTaYw5kI-yWWawl6zp8Srhuf5NK0',
            kid: 'local-placeholder',
          },
        ],
      },
    });
  });

  it('accepts the committed .env.example as it is', () => {
    const example: NodeJS.Dict<string> = parseEnv(
      readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'),
    );

    expect(() => loadConfig(appConfigSchema, example)).not.toThrow();
    expect(() => loadConfig(migrationConfigSchema, example)).not.toThrow();
  });

  it('loads the Meilisearch endpoint and API key together', () => {
    const settings = {
      MEILI_URL: 'https://search.example.test:7700/meili',
      MEILI_API_KEY: 'fixture-meili-key',
    };

    expect(loadConfig(appConfigSchema, { ...complete, ...settings })).toMatchObject(settings);
  });

  it('treats two empty Meilisearch settings as absent', () => {
    const config = loadConfig(appConfigSchema, { ...complete, MEILI_URL: '', MEILI_API_KEY: '' });

    expect(config).not.toHaveProperty('MEILI_URL');
    expect(config).not.toHaveProperty('MEILI_API_KEY');
  });

  it('names the missing Meilisearch variable when only one is configured', () => {
    expect(() =>
      loadConfig(appConfigSchema, { ...complete, MEILI_URL: 'http://meilisearch:7700' }),
    ).toThrow(/MEILI_API_KEY: required, not set/u);
    expect(() =>
      loadConfig(appConfigSchema, { ...complete, MEILI_API_KEY: 'fixture-meili-key' }),
    ).toThrow(/MEILI_URL: required, not set/u);
  });

  it.each([
    'ftp://meilisearch:7700',
    'http:meilisearch',
    'https://fixture-username:fixture-password@meilisearch',
    'https://meilisearch?key=fixture-query',
    'https://meilisearch#fixture-fragment',
  ])('refuses an invalid Meilisearch endpoint with a generic diagnostic', (endpoint) => {
    const load = (): void => {
      loadConfig(appConfigSchema, {
        ...complete,
        MEILI_URL: endpoint,
        MEILI_API_KEY: 'fixture-meili-key',
      });
    };

    expect(load).toThrow(
      /^Invalid configuration:\n- MEILI_URL: Expected a Meilisearch HTTP\(S\) URL without credentials, query or fragment\.$/u,
    );
  });

  it('refuses an invalid Meilisearch API key without printing it', () => {
    const load = (): void => {
      loadConfig(appConfigSchema, {
        ...complete,
        MEILI_URL: 'http://meilisearch:7700',
        MEILI_API_KEY: 'fixture-key\nwith-a-break',
      });
    };

    expect(load).toThrow(
      /^Invalid configuration:\n- MEILI_API_KEY: Expected a Meilisearch API key made of visible ASCII characters\.$/u,
    );
  });

  it('refuses to start without the database, the broker, the audience or the trusted issuers', () => {
    expect(() => loadConfig(appConfigSchema, { PORT: '3019' })).toThrow(ConfigError);
    try {
      loadConfig(appConfigSchema, { PORT: '3019' });
    } catch (error) {
      const issues: readonly string[] = (error as ConfigError).issues;
      expect(issues.map((issue) => issue.split(':')[0])).toEqual(
        expect.arrayContaining([
          'DATABASE_URL',
          'NATS_URL',
          'INTERNAL_TOKEN_AUDIENCE',
          'INTERNAL_TOKEN_TRUSTED_ISSUERS',
        ]),
      );
    }
  });

  it('refuses a database URL that is not PostgreSQL, without printing it', () => {
    const secret: string = 'mysql://search_app:s3cret@localhost/search';

    expect(() => loadConfig(appConfigSchema, { ...complete, DATABASE_URL: secret })).toThrow(
      /DATABASE_URL/u,
    );
    expect(() => loadConfig(appConfigSchema, { ...complete, DATABASE_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });

  it('refuses a broker URL that is not NATS, without printing it', () => {
    const secret: string = 'http://search:s3cret@localhost:4222';

    expect(() => loadConfig(appConfigSchema, { ...complete, NATS_URL: secret })).toThrow(
      /NATS_URL/u,
    );
    expect(() => loadConfig(appConfigSchema, { ...complete, NATS_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });

  it('refuses a private key listed as a verification key', () => {
    const withPrivateKey: string = trustedIssuers.replace('"kid"', `"d":"${'A'.repeat(43)}","kid"`);

    expect(() =>
      loadConfig(appConfigSchema, { ...complete, INTERNAL_TOKEN_TRUSTED_ISSUERS: withPrivateKey }),
    ).toThrow(/INTERNAL_TOKEN_TRUSTED_ISSUERS/u);
  });

  it('does not read the migrator URL: the running service never needs it', () => {
    expect(loadConfig(appConfigSchema, complete)).not.toHaveProperty('MIGRATION_DATABASE_URL');
  });
});

describe('migrationConfigSchema', () => {
  it('reads the URL of the migrator role', () => {
    expect(
      loadConfig(migrationConfigSchema, {
        MIGRATION_DATABASE_URL: 'postgres://search_migrator:search_migrator@localhost:5432/search',
      }),
    ).toEqual({
      MIGRATION_DATABASE_URL: 'postgres://search_migrator:search_migrator@localhost:5432/search',
    });
  });

  it('names MIGRATION_DATABASE_URL when it is missing', () => {
    expect(() =>
      loadConfig(migrationConfigSchema, {
        DATABASE_URL: 'postgres://search_app:search_app@localhost:5432/search',
      }),
    ).toThrow(/MIGRATION_DATABASE_URL: required, not set/u);
  });

  it('names MIGRATION_DATABASE_URL when it is not a PostgreSQL URL, without printing it', () => {
    const secret: string = 'mysql://search_migrator:s3cret@localhost/search';

    expect(() => loadConfig(migrationConfigSchema, { MIGRATION_DATABASE_URL: secret })).toThrow(
      /MIGRATION_DATABASE_URL: Expected the postgres:\/\/ URL of the migrator role/u,
    );
    expect(() => loadConfig(migrationConfigSchema, { MIGRATION_DATABASE_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });
});
