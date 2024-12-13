import { Either, left, right } from 'fp-ts/Either';
import { EventService, TransactionContext } from './types';

export class EventSchedulerService {
  private readonly UPDATE_INTERVAL = 300000; // 5 minutes in milliseconds
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly eventService: EventService,
    private readonly transactionContext: TransactionContext,
  ) {}

  async scheduleEventUpdates(): Promise<Either<Error, void>> {
    try {
      await this.transactionContext.start();

      // Clear existing timer if any
      if (this.updateTimer) {
        clearInterval(this.updateTimer);
      }

      // Perform initial update without starting a new transaction
      await this.performScheduledUpdate(false);

      // Schedule periodic updates
      this.updateTimer = setInterval(() => {
        void this.performScheduledUpdate(true);
      }, this.UPDATE_INTERVAL);

      await this.transactionContext.commit();
      return right(undefined);
    } catch (error) {
      await this.transactionContext.rollback();
      return left(error instanceof Error ? error : new Error('Failed to schedule event updates'));
    }
  }

  private async performScheduledUpdate(startNewTransaction: boolean = true): Promise<void> {
    try {
      if (startNewTransaction) {
        await this.transactionContext.start();
      }

      // Sync events
      const syncResult = await this.eventService.syncEvents();
      if (syncResult._tag === 'Left') {
        if (startNewTransaction) {
          await this.transactionContext.rollback();
        }
        console.error('Failed to sync events during scheduled update:', syncResult.left);
        return;
      }

      // Verify synced events
      const events = syncResult.right;
      for (const event of events) {
        const verificationResult = await this.eventService.verifyEventData(event.id);
        if (verificationResult._tag === 'Left') {
          console.error(`Failed to verify event ${event.id}:`, verificationResult.left);
        }
      }

      if (startNewTransaction) {
        await this.transactionContext.commit();
      }
    } catch (error) {
      if (startNewTransaction) {
        await this.transactionContext.rollback();
      }
      console.error('Error during scheduled update:', error);
    }
  }

  stopScheduler(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }
}
