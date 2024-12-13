import { Either, left, right } from 'fp-ts/Either';
import { EventService, TransactionContext } from './types';

export class EventBootstrapService {
  constructor(
    private readonly eventService: EventService,
    private readonly transactionContext: TransactionContext,
  ) {}

  async initialize(): Promise<Either<Error, void>> {
    try {
      await this.transactionContext.start();

      // Initialize event service
      const initResult = await this.eventService.initialize();
      if (initResult._tag === 'Left') {
        await this.transactionContext.rollback();
        return left(initResult.left);
      }

      // Sync initial events
      const syncResult = await this.eventService.syncEvents();
      if (syncResult._tag === 'Left') {
        await this.transactionContext.rollback();
        return left(syncResult.left);
      }

      // Schedule event updates
      const scheduleResult = await this.eventService.scheduleEventUpdates();
      if (scheduleResult._tag === 'Left') {
        await this.transactionContext.rollback();
        return left(scheduleResult.left);
      }

      await this.transactionContext.commit();
      return right(undefined);
    } catch (error) {
      await this.transactionContext.rollback();
      return left(
        error instanceof Error ? error : new Error('Unknown error during initialization'),
      );
    }
  }
}
