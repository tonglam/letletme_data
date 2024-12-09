import { Either, left, right } from 'fp-ts/Either';
import { EventService, FPLEvent, TransactionContext } from './types';

export class EventVerificationService {
  constructor(
    private readonly eventService: EventService,
    private readonly transactionContext: TransactionContext,
  ) {}

  public async verifyEventData(eventId: number): Promise<Either<Error, boolean>> {
    try {
      await this.transactionContext.start();

      // Get event details
      const eventResult = await this.eventService.syncEventDetails(eventId);

      if (eventResult._tag === 'Left') {
        await this.transactionContext.rollback();
        return left(new Error('Failed to fetch event for verification'));
      }

      const event = (eventResult as unknown as { right: FPLEvent }).right;
      const isValid = await this.validateEvent(event);

      await this.transactionContext.commit();
      return right(isValid);
    } catch (error) {
      await this.transactionContext.rollback();
      return left(error instanceof Error ? error : new Error('Failed to verify event data'));
    }
  }

  private async validateEvent(event: FPLEvent): Promise<boolean> {
    // Implementation would include:
    // 1. Validate event structure
    // 2. Check data consistency
    // 3. Verify relationships
    // 4. Cross-reference with other data sources

    const isValidStructure = this.validateEventStructure(event);
    const isValidTiming = this.validateEventTiming(event);
    const isValidStatus = this.validateEventStatus(event);

    return isValidStructure && isValidTiming && isValidStatus;
  }

  private validateEventStructure(event: FPLEvent): boolean {
    return (
      typeof event.id === 'number' &&
      typeof event.name === 'string' &&
      event.name.length > 0 &&
      event.startTime instanceof Date &&
      event.endTime instanceof Date &&
      typeof event.details.description === 'string'
    );
  }

  private validateEventTiming(event: FPLEvent): boolean {
    const now = new Date();
    return event.startTime <= event.endTime && event.endTime > now;
  }

  private validateEventStatus(event: FPLEvent): boolean {
    const validStatuses = ['PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED'];
    return validStatuses.includes(event.status);
  }
}
