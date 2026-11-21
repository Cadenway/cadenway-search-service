import { SearchInternalQueryParams } from '@cadenway/contracts/validators/internal/search-service';
import { z } from 'zod';

/** The published query, with strict scalar and cursor limits applied before coercion. */
export const searchPaletteQuery = z
  .object({
    q: z.string(),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.string().regex(/^\d+$/u).optional(),
  })
  .catchall(z.unknown())
  .superRefine((value, context) => {
    if (Object.keys(value).some((key) => key !== 'q' && key !== 'cursor' && key !== 'limit')) {
      context.addIssue({ code: 'custom', message: 'Unknown query parameter.' });
    }
  })
  .transform((value, context) => {
    const result = SearchInternalQueryParams.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: 'Invalid parameter.' });
      }
      return z.NEVER;
    }
    return result.data;
  });
