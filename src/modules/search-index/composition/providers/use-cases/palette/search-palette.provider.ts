import { CONFIG } from '@cadenway/nest-common';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { SearchPalette } from '../../../../application/use-cases/queries/palette/search-palette/search-palette.use-case.js';
import { AesPaletteCursorAdapter } from '../../../../infrastructure/adapters/crypto/palette/aes-palette-cursor.adapter.js';
import type { MeilisearchIndexAdapter } from '../../../../infrastructure/adapters/meilisearch/meilisearch-index.adapter.js';
import { SEARCH_AUTHORITIES } from '../../../tokens/authority/search-authorities.token.js';
import { SEARCH_INDEX_ENGINE } from '../../../tokens/rebuild/search-index-engine.token.js';
import type { SearchAuthorities } from '../../adapters/authority/search-authorities.provider.js';

/** Creates the authorized palette when all its dependencies are configured. */
export const searchPaletteProvider: FactoryProvider<SearchPalette | null> = {
  provide: SearchPalette,
  inject: [CONFIG, SEARCH_INDEX_ENGINE, SEARCH_AUTHORITIES],
  useFactory: (
    config: AppConfig,
    engine: MeilisearchIndexAdapter | null,
    authorities: SearchAuthorities | null,
  ): SearchPalette | null => {
    const cursorKey = config.SEARCH_PALETTE_CURSOR_SECRET;
    if (engine === null || authorities === null || cursorKey === undefined) return null;
    const cursor = new AesPaletteCursorAdapter(Buffer.from(cursorKey, 'base64url'));
    return new SearchPalette(engine, authorities.delegated, cursor);
  },
};
