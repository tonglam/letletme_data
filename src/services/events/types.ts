import { Either } from 'fp-ts/Either';
import { Option } from 'fp-ts/Option';

export interface FPLEvent {
  readonly id: number;
  readonly name: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly status: EventStatus;
  readonly details: EventDetails;
}

export interface EventDetails {
  readonly description: string;
  readonly metadata: Record<string, unknown>;
}

export enum EventStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface EventService {
  // Bootstrap operations
  initialize(): Promise<Either<Error, void>>;

  // Sync operations
  syncEvents(): Promise<Either<Error, ReadonlyArray<FPLEvent>>>;
  syncEventDetails(eventId: number): Promise<Either<Error, FPLEvent>>;

  // Verification operations
  verifyEventData(eventId: number): Promise<Either<Error, boolean>>;

  // Schedule operations
  scheduleEventUpdates(): Promise<Either<Error, void>>;
}

export interface CacheStrategy {
  readonly get: <T>(key: string) => Promise<Option<T>>;
  readonly set: <T>(key: string, value: T, ttl?: number) => Promise<void>;
  readonly invalidate: (pattern: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface TransactionContext {
  readonly start: () => Promise<void>;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
  readonly isActive: boolean;
}
