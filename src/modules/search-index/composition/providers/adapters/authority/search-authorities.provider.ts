import { CONFIG, InternalHttpClient, InternalTokenSigner } from '@cadenway/nest-common';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import type { SearchDelegatedAuthority } from '../../../../application/ports/outbound/http/authority/search-delegated-authority.port.js';
import type { SearchSystemAuthority } from '../../../../application/ports/outbound/http/authority/search-system-authority.port.js';
import { DocumentSearchAuthorityAdapter } from '../../../../infrastructure/adapters/authority/document-search-authority.adapter.js';
import { OrganizationSearchAuthorityAdapter } from '../../../../infrastructure/adapters/authority/organization-search-authority.adapter.js';
import { StorageSearchAuthorityAdapter } from '../../../../infrastructure/adapters/authority/storage-search-authority.adapter.js';
import { TaskSearchAuthorityAdapter } from '../../../../infrastructure/adapters/authority/task-search-authority.adapter.js';
import { SEARCH_AUTHORITIES } from '../../../tokens/authority/search-authorities.token.js';

/** Owner clients available to the Search use cases. */
export interface SearchAuthorities {
  // #region Properties
  /** System reads of authoritative projections for rebuilding or refreshing the index. */
  readonly system: SearchSystemAuthority;

  /** Current user and membership evidence for the command palette. */
  readonly delegated: SearchDelegatedAuthority;
  // #endregion
}

/** Composes one signed, audience-specific HTTP client per owning service. */
export const searchAuthoritiesProvider: FactoryProvider<SearchAuthorities | null> = {
  provide: SEARCH_AUTHORITIES,
  inject: [CONFIG],
  useFactory: async (config: AppConfig): Promise<SearchAuthorities | null> => {
    const privateJwk = config.INTERNAL_TOKEN_PRIVATE_JWK;
    const taskUrl = config.TASK_SERVICE_URL;
    const organizationUrl = config.ORGANIZATION_SERVICE_URL;
    const documentUrl = config.DOCUMENT_SERVICE_URL;
    const storageUrl = config.STORAGE_SERVICE_URL;
    if (!privateJwk || !taskUrl || !organizationUrl || !documentUrl || !storageUrl) return null;

    const signer = await InternalTokenSigner.create({ issuer: 'search-service', privateJwk });
    const task = new TaskSearchAuthorityAdapter(
      new InternalHttpClient({ service: 'task-service', baseUrl: taskUrl, signer }),
    );
    const organization = new OrganizationSearchAuthorityAdapter(
      new InternalHttpClient({ service: 'organization-service', baseUrl: organizationUrl, signer }),
    );
    const document = new DocumentSearchAuthorityAdapter(
      new InternalHttpClient({ service: 'document-service', baseUrl: documentUrl, signer }),
    );
    const storage = new StorageSearchAuthorityAdapter(
      new InternalHttpClient({ service: 'storage-service', baseUrl: storageUrl, signer }),
    );
    return {
      system: {
        listOrganizations: organization.listOrganizations.bind(organization),
        listTaskProjections: task.listTaskProjections.bind(task),
        resolveTaskProjections: task.resolveTaskProjections.bind(task),
        listDocuments: document.listDocuments.bind(document),
        resolveDocuments: document.resolveDocuments.bind(document),
        listAttachments: storage.listAttachments.bind(storage),
        resolveAttachments: storage.resolveAttachments.bind(storage),
      },
      delegated: {
        getMembership: organization.getMembership.bind(organization),
        resolveAccess: task.resolveAccess.bind(task),
      },
    };
  },
};
