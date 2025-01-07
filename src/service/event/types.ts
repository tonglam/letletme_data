/**
 * Event Service Types Module
 * Contains type definitions for the event service layer.
 */

import { ExtendedBootstrapApi } from 'domains/bootstrap/types';
import * as TE from 'fp-ts/TaskEither';
import type { ServiceError } from '../../types/error.type';
import type { Event, EventId } from '../../types/event.type';

/**
 * Public interface for the event service.
 * Provides high-level operations for event management.
 */
export interface EventService {
  readonly getEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly saveEvents: (events: readonly Event[]) => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, readonly Event[]>;
}

/**
 * Complete event service interface including workflows.
 * This is the public interface exposed to consumers.
 */
export interface EventServiceWithWorkflows extends EventService {
  readonly workflows: {
    readonly syncEvents: () => TE.TaskEither<ServiceError, WorkflowResult<readonly Event[]>>;
  };
}

/**
 * External dependencies required by the event service.
 */
export interface EventServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
}

/**
 * Internal operations used by the service implementation.
 * Maps closely to domain operations but with service-level error handling.
 */
export interface EventServiceOperations {
  readonly findAllEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly findEventById: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly findCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly findNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly syncEventsFromApi: (
    bootstrapApi: EventServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, readonly Event[]>;
}

/**
 * Context for tracking workflow execution.
 */
export interface WorkflowContext {
  readonly workflowId: string;
  readonly startTime: Date;
}

/**
 * Generic result type for workflow operations.
 * Includes execution context and metrics.
 */
export interface WorkflowResult<T> {
  readonly context: WorkflowContext;
  readonly result: T;
  readonly duration: number;
}
