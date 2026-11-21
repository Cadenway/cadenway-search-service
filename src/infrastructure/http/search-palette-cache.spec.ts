import { Controller, Get, HttpException } from '@nestjs/common';
import { ProblemException, ProblemFilter } from '@cadenway/nest-common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { configureSearchPaletteCache } from './search-palette-cache.js';

@Controller('internal/v1/search')
class FixtureController {
  // #region Methods
  /** Returns a small cacheable response for the conditional-request fixture. */
  @Get()
  public search(): { items: readonly never[]; nextCursor: null } {
    return { items: [], nextCursor: null };
  }

  /** Returns an error for the fixture route. */
  @Get('refused')
  public refused(): never {
    throw new HttpException('Refused', 401);
  }
  // #endregion
}

describe('palette cache policy', () => {
  it.each([
    [Object.assign(new Error('private parser content'), { status: 400 }), 'request.invalid'],
    [Object.assign(new Error('private charset'), { status: 415 }), 'request.invalid'],
    [Object.assign(new Error('private body'), { status: 413 }), 'request.body-too-large'],
    [new ProblemException({ status: 400, code: 'request.invalid' }), 'request.invalid'],
  ])('preserves private parser errors with the contracted code', async (failure, code) => {
    const module = await Test.createTestingModule({ controllers: [FixtureController] }).compile();
    const app = module.createNestApplication<NestExpressApplication>();
    app.use('/internal/v1/search', (_request: unknown, _response: unknown, next: NextFunction) => {
      next(failure);
    });
    configureSearchPaletteCache(app);
    app.useGlobalFilters(new ProblemFilter());
    await app.init();

    const response = await request(app.getHttpServer()).get('/internal/v1/search');
    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({ code });
    expect(JSON.stringify(response.body)).not.toContain('private');
    if (failure instanceof ProblemException) {
      expect(response.body).toEqual(failure.problem);
    } else if (code === 'request.invalid') {
      expect(response.body).toMatchObject({
        details: { issues: [{ in: 'body', path: '', code: 'invalid_format' }] },
      });
    }
    await app.close();
  });

  it('keeps conditional requests private and returns the complete page', async () => {
    const module = await Test.createTestingModule({ controllers: [FixtureController] }).compile();
    const app = module.createNestApplication<NestExpressApplication>();
    configureSearchPaletteCache(app);
    await app.init();

    const first = await request(app.getHttpServer()).get('/internal/v1/search');
    const conditional = await request(app.getHttpServer())
      .get('/internal/v1/search')
      .set('If-None-Match', String(first.headers.etag))
      .set('If-Modified-Since', new Date().toUTCString());
    expect(conditional.status).toBe(200);
    expect(conditional.headers['cache-control']).toBe('private, no-store');
    expect(conditional.body).toEqual({ items: [], nextCursor: null });
    await app.close();
  });

  it('applies private cache control to errors before the route', async () => {
    const module = await Test.createTestingModule({ controllers: [FixtureController] }).compile();
    const app = module.createNestApplication<NestExpressApplication>();
    configureSearchPaletteCache(app);
    app.use(
      '/internal/v1/search',
      (
        _request: unknown,
        response: { status: (code: number) => { json: (body: object) => void } },
      ) => {
        response.status(401).json({ code: 'auth.token-missing' });
      },
    );
    await app.init();
    const response = await request(app.getHttpServer()).get('/internal/v1/search');
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });
});
