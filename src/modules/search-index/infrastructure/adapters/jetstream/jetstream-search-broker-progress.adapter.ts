import type { EventConsumers, MessagingConnection } from '@cadenway/nest-messaging';

import type { SearchBrokerProgressReader } from '../../../application/ports/outbound/messaging/rebuild/search-broker-progress-reader.port.js';
import type { SearchRebuildBrokerProgress } from '../../../domain/value-objects/rebuild/search-rebuild-broker-progress.value-object.js';

const eventStream = 'EVENTS';
const advisoryStream = 'SEARCH_REBUILD_ADVISORIES';

/** Samples the Search durables and checks the persistent JetStream advisory guard. */
export class JetStreamSearchBrokerProgressAdapter implements SearchBrokerProgressReader {
  // #region Properties
  /** Full durable names used by the advisory stream's native subject filters. */
  private readonly durableNames: readonly string[];
  // #endregion

  // #region Constructor
  /** Binds the kit clients and the exact Search consumer set. */
  public constructor(
    private readonly connection: Pick<MessagingConnection, 'isConsumerAdvisoryStreamClear'>,
    private readonly consumers: Pick<EventConsumers, 'readProgress'>,
    private readonly handlerNames: readonly string[],
  ) {
    this.durableNames = handlerNames.map((handler) => `search-service__${handler}`);
  }
  // #endregion

  // #region Methods
  /** Returns no proof if the stream, consumer set or terminal advisory state is uncertain. */
  public async read(signal?: AbortSignal): Promise<SearchRebuildBrokerProgress | null> {
    if (!(await this.advisoriesClear(signal))) return null;
    const progress = await this.consumers.readProgress(this.handlerNames, signal);
    if (progress?.stream !== eventStream || !(await this.advisoriesClear(signal))) return null;
    return progress;
  }

  private async advisoriesClear(signal?: AbortSignal): Promise<boolean> {
    return this.connection.isConsumerAdvisoryStreamClear(
      advisoryStream,
      eventStream,
      this.durableNames,
      signal,
    );
  }
  // #endregion
}
