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
    private readonly connection: Pick<MessagingConnection, 'consumerAdvisoryStreamState'>,
    private readonly consumers: Pick<EventConsumers, 'readProgress'>,
    private readonly handlerNames: readonly string[],
  ) {
    this.durableNames = handlerNames.map((handler) => `search-service__${handler}`);
  }
  // #endregion

  // #region Methods
  /** Returns no proof if the stream, consumer set or terminal advisory state is uncertain. */
  public async read(signal?: AbortSignal): Promise<SearchRebuildBrokerProgress | null> {
    const before = await this.advisoryState(signal);
    if (before.state !== 'clear') return null;
    const progress = await this.consumers.readProgress(this.handlerNames, signal);
    const after = await this.advisoryState(signal);
    if (
      progress?.stream !== eventStream ||
      after.state !== 'clear' ||
      before.createdAt === null ||
      before.lastSequence === null ||
      before.createdAt !== after.createdAt ||
      before.lastSequence !== after.lastSequence
    )
      return null;
    return {
      ...progress,
      advisoryLatch: { createdAt: before.createdAt, lastSequence: before.lastSequence },
    };
  }

  private async advisoryState(signal?: AbortSignal) {
    return this.connection.consumerAdvisoryStreamState(
      advisoryStream,
      eventStream,
      this.durableNames,
      signal,
    );
  }
  // #endregion
}
