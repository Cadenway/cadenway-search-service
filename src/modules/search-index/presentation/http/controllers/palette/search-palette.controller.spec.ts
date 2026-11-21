import { EventEmitter } from 'node:events';

import {
  ProblemException,
  runWithDeadline,
  runWithOrganizationContext,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { SearchPalette } from '../../../../application/use-cases/queries/palette/search-palette/search-palette.use-case.js';
import { searchPaletteQuery } from '../../validation/palette/search-palette-query.validation.js';

import { SearchPaletteController } from './search-palette.controller.js';

const organizationId = '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e01';
const userId = '019a6f99-3ec0-7c2a-8e4a-2b8d41c98e02';
const context = {
  organizationId,
  actor: { type: 'user' as const, id: userId },
  role: null,
  scopes: [],
};
const query = { q: 'SSO', limit: 50 };

function request(): Request {
  return Object.assign(new EventEmitter(), { res: new EventEmitter() }) as Request;
}

describe('SearchPaletteController', () => {
  it('uses the verified context and validates the returned fields against the published contract', async () => {
    const execute = vi.fn().mockResolvedValue({
      kind: 'ok',
      items: [
        { kind: 'task', taskKey: 'CAD-482', name: 'SSO', status: 'progress', private: 'hidden' },
      ],
      nextCursor: null,
      private: 'hidden',
    });
    const controller = new SearchPaletteController({ execute } as unknown as SearchPalette);
    const response = await runWithOrganizationContext(context, () =>
      controller.search(query, request()),
    );
    expect(response).toEqual({
      items: [{ kind: 'task', taskKey: 'CAD-482', name: 'SSO', status: 'progress' }],
      nextCursor: null,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId, query: 'SSO', limit: 50 }),
    );
  });

  it.each([
    ['invalid', 400, 'request.invalid'],
    ['not-found', 404, 'organization.not-found'],
    ['unavailable', 503, 'search.unavailable'],
  ] as const)('maps %s without exposing internal details', async (kind, status, code) => {
    const controller = new SearchPaletteController({
      execute: vi.fn().mockResolvedValue({ kind }),
    } as unknown as SearchPalette);
    await expect(
      runWithOrganizationContext(context, () => controller.search(query, request())),
    ).rejects.toMatchObject({
      status,
      response: { code },
    });
  });

  it('fails closed for an invalid engine response or an unconfigured operation', async () => {
    const malformed = new SearchPaletteController({
      execute: vi.fn().mockResolvedValue({ kind: 'ok', items: [], nextCursor: '' }),
    } as unknown as SearchPalette);
    const disabled = new SearchPaletteController(null);
    for (const controller of [malformed, disabled]) {
      await expect(
        runWithOrganizationContext(context, () => controller.search(query, request())),
      ).rejects.toMatchObject({ status: 503 });
    }
  });

  it('aborts an unfinished search when its request budget expires', async () => {
    const execute = vi
      .fn<SearchPalette['execute']>()
      .mockImplementation(async () => new Promise(() => undefined));
    const controller = new SearchPaletteController({ execute } as unknown as SearchPalette);
    await expect(
      runWithDeadline(10, () =>
        runWithOrganizationContext(context, () => controller.search(query, request())),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(execute.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});

describe('palette query validation', () => {
  const pipe = new ZodValidationPipe(searchPaletteQuery);
  const metadata = { type: 'query' as const, metatype: Object };

  it('applies the generated default and accepts bounded scalar values', () => {
    expect(pipe.transform({ q: 'SSO' }, metadata)).toEqual({ q: 'SSO', limit: 50 });
    expect(pipe.transform({ q: 'SSO', limit: '100', cursor: 'x' }, metadata)).toEqual({
      q: 'SSO',
      limit: 100,
      cursor: 'x',
    });
  });

  it.each([
    { q: ['SSO', 'other'] },
    { q: 'SSO', limit: ['1'] },
    { q: 'SSO', extra: 'value' },
    { q: ' ' },
    { q: 'SSO', limit: '101' },
    { q: 'SSO', cursor: '' },
    { q: 'SSO', cursor: 'x'.repeat(1025) },
  ])('rejects invalid and ambiguous query parameters', (value) => {
    expect(() => pipe.transform(value, metadata)).toThrow();
  });

  it('does not disclose an unknown parameter name or its value in the 400 problem', () => {
    const marker = 'private-query-marker';
    try {
      pipe.transform({ q: 'SSO', [marker]: marker }, metadata);
      throw new Error('Expected invalid query.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProblemException);
      if (!(error instanceof ProblemException)) throw error;
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: 'request.invalid' });
      expect(JSON.stringify(error.getResponse())).not.toContain(marker);
    }
  });
});
