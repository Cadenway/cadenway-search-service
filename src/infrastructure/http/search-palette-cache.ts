import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

const searchPath = /^\/internal\/v1\/search\/?$/iu;

/** Makes every palette response private, including errors raised before the controller. */
export function configureSearchPaletteCache(app: Pick<NestExpressApplication, 'use'>): void {
  app.use(searchPath, (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method === 'GET' || request.method === 'HEAD') {
      delete request.headers['if-none-match'];
      delete request.headers['if-modified-since'];
    }
    next();
  });
  app.use(
    searchPath,
    (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
      response.setHeader('Cache-Control', 'private, no-store');
      const problem = toProblem(error);
      if (
        error instanceof ProblemException ||
        problem.status !== 400 ||
        problem.code === 'request.body-too-large'
      ) {
        next(error);
        return;
      }
      next(
        new ProblemException({
          status: 400,
          code: 'request.invalid',
          details: {
            issues: [
              { in: 'body', path: '', code: 'invalid_format', message: 'Invalid request body.' },
            ],
          },
        }),
      );
    },
  );
}
import { ProblemException, toProblem } from '@cadenway/nest-common';
