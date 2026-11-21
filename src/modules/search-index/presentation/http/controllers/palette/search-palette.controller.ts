import { SearchInternalResponse } from '@cadenway/contracts/validators/internal/search-service';
import {
  DEFAULT_REQUEST_BUDGET_MS,
  getOrganizationContext,
  InternalAccess,
  ProblemException,
  remainingBudgetMs,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';

import { SearchPalette } from '../../../../application/use-cases/queries/palette/search-palette/search-palette.use-case.js';
import { searchPaletteQuery } from '../../validation/palette/search-palette-query.validation.js';

/** Searches only resources authorized for the user in the signed gateway token. */
@Controller('internal/v1/search')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class SearchPaletteController {
  // #region Constructor
  /** Receives the palette operation, when its dependencies are configured. */
  public constructor(@Inject(SearchPalette) private readonly palette: SearchPalette | null) {}
  // #endregion

  // #region Methods
  /** Returns a validated private page within the current request deadline. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public async search(
    @Query(new ZodValidationPipe(searchPaletteQuery)) query: z.output<typeof searchPaletteQuery>,
    @Req() request: Request,
  ): Promise<z.output<typeof SearchInternalResponse>> {
    const context = getOrganizationContext();
    if (context?.actor.type !== 'user' || context.actor.id === null) {
      throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
    }
    if (context.organizationId === null) {
      throw new ProblemException({ status: 403, code: 'auth.organization-required' });
    }
    const budget = remainingBudgetMs() ?? DEFAULT_REQUEST_BUDGET_MS;
    if (this.palette === null || budget <= 0) {
      throw new ProblemException({ status: 503, code: 'search.unavailable' });
    }
    const abort = new AbortController();
    const disconnect = (): void => {
      abort.abort();
    };
    request.once('aborted', disconnect);
    request.res?.once('close', disconnect);
    const timer = setTimeout(disconnect, Math.ceil(budget));
    try {
      const result = await Promise.race([
        this.palette.execute({
          organizationId: context.organizationId,
          userId: context.actor.id,
          query: query.q,
          limit: query.limit,
          cursor: query.cursor,
          signal: abort.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          abort.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('Search request ended.'));
            },
            { once: true },
          );
        }),
      ]);
      if (abort.signal.aborted) throw new Error('Search request ended.');
      if (result.kind === 'invalid') {
        throw new ProblemException({
          status: 400,
          code: 'request.invalid',
          details: {
            issues: [
              { in: 'query', path: 'cursor', code: 'invalid_cursor', message: 'Invalid cursor.' },
            ],
          },
        });
      }
      if (result.kind === 'not-found') {
        throw new ProblemException({ status: 404, code: 'organization.not-found' });
      }
      if (result.kind !== 'ok')
        throw new ProblemException({ status: 503, code: 'search.unavailable' });
      const response = SearchInternalResponse.safeParse(result);
      if (!response.success)
        throw new ProblemException({ status: 503, code: 'search.unavailable' });
      return response.data;
    } catch (error: unknown) {
      if (error instanceof ProblemException) throw error;
      throw new ProblemException({ status: 503, code: 'search.unavailable' });
    } finally {
      clearTimeout(timer);
      request.off('aborted', disconnect);
      request.res?.off('close', disconnect);
    }
  }
  // #endregion
}
