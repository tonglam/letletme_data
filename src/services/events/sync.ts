import { Either, left, right } from 'fp-ts/Either';
import { CacheStrategy, FPLEvent, TransactionContext } from './types';

export class EventSyncService {
  private readonly CACHE_TTL = 3600; // 1 hour in seconds
  private readonly EVENT_CACHE_PREFIX = 'event:';

  constructor(
    private readonly cacheStrategy: CacheStrategy,
    private readonly transactionContext: TransactionContext,
  ) {}

  public async syncEvents(): Promise<Either<Error, ReadonlyArray<FPLEvent>>> {
    try {
      await this.transactionContext.start();

      // Implementation would include:
      // 1. Fetch latest events from external source
      // 2. Compare with cached data
      // 3. Update only changed events
      // 4. Update cache

      await this.transactionContext.commit();
      return right([] as ReadonlyArray<FPLEvent>); // Placeholder return
    } catch (error) {
      await this.transactionContext.rollback();
      return left(error instanceof Error ? error : new Error('Failed to sync events'));
    }
  }

  public async syncEventDetails(eventId: number): Promise<Either<Error, FPLEvent>> {
    try {
      const cacheKey = `${this.EVENT_CACHE_PREFIX}${eventId}`;

      // Check cache first
      const cachedEvent = await this.cacheStrategy.get<FPLEvent>(cacheKey);

      if (cachedEvent._tag === 'Some') {
        return right(cachedEvent.value);
      }

      await this.transactionContext.start();

      // Implementation would include:
      // 1. Fetch event details from external source
      // 2. Update local storage
      // 3. Update cache

      await this.transactionContext.commit();

      // Placeholder return
      return left(new Error('Event not found'));
    } catch (error) {
      await this.transactionContext.rollback();
      return left(error instanceof Error ? error : new Error('Failed to sync event details'));
    }
  }

  private async updateEventCache(event: FPLEvent): Promise<void> {
    const cacheKey = `${this.EVENT_CACHE_PREFIX}${event.id}`;
    await this.cacheStrategy.set(cacheKey, event, this.CACHE_TTL);
  }
}
