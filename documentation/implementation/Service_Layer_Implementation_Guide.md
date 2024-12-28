# Service Layer Implementation Guide

## Table of Contents

- [Service Layer Implementation Guide](#service-layer-implementation-guide)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [File Structure](#file-structure)
  - [Service Types](#service-types)
  - [Service Implementation](#service-implementation)
  - [Cache Integration](#cache-integration)
  - [Workflow Implementation](#workflow-implementation)

## Overview

This guide demonstrates how to implement a service layer following functional programming principles using fp-ts. The Events service serves as our reference implementation.

## File Structure

```
src/services/{service-name}/
├── index.ts     # Public API exports
├── types.ts     # Service interfaces and types
├── service.ts   # Main service implementation
├── cache.ts     # Service-level cache
└── workflow.ts  # Complex business workflows
```

## Service Types

Define service interfaces in `types.ts`:

```typescript
export interface EventService {
  readonly warmUp: () => TE.TaskEither<APIError, void>;
  readonly getEvents: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<APIError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly fetchFromApi: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly validateAndTransform: (
    events: readonly Event[],
  ) => TE.TaskEither<APIError, readonly Event[]>;
  readonly saveToDb: (events: readonly Event[]) => TE.TaskEither<APIError, readonly Event[]>;
  readonly updateCache: (events: readonly Event[]) => TE.TaskEither<APIError, readonly Event[]>;
}

export interface EventServiceDependencies {
  readonly bootstrapApi: BootstrapApi;
  readonly eventCache: EventCache;
  readonly eventRepository: EventRepository;
}
```

## Service Implementation

Implement service using pure functions and dependency injection in `service.ts`:

```typescript
export const createEventServiceImpl = ({
  bootstrapApi,
  eventCache,
  eventRepository,
}: EventServiceDependencies): EventService => {
  const warmUp = (): TE.TaskEither<APIError, void> =>
    pipe(
      eventCache.warmUp(),
      TE.mapLeft((error) =>
        createValidationError({ message: `Cache warm-up failed: ${error.message}` }),
      ),
    );

  const getEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    findAllEvents(eventRepository, eventCache);

  const getEvent = (id: EventId): TE.TaskEither<APIError, Event | null> =>
    findEventById(eventRepository, eventCache, id);

  const fetchFromApi = (): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        () => bootstrapApi.getBootstrapData(),
        (error) =>
          createValidationError({
            message: `Failed to fetch events from API: ${String(error)}`,
          }),
      ),
      TE.map((response) => response.events.map(toDomainEvent)),
    );

  const validateAndTransform = (
    events: readonly Event[],
  ): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      events,
      TE.right,
      TE.chain((events) =>
        events.every((event) => event.id && event.name && event.deadlineTime)
          ? TE.right(events)
          : TE.left(createValidationError({ message: 'Invalid event data' })),
      ),
    );

  return {
    warmUp,
    getEvents,
    getEvent,
    fetchFromApi,
    validateAndTransform,
    // ... other operations
  };
};
```

## Cache Integration

Service-level cache implementation in `cache.ts`:

```typescript
export interface EventServiceCache {
  readonly getEvents: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly setEvents: (events: readonly Event[]) => TE.TaskEither<APIError, void>;
}

export const createEventServiceCache = (redis: RedisClient): EventServiceCache => {
  const cacheKey = 'service:events:all';

  const getEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        () => redis.get(cacheKey),
        (error) => new APIError('Cache error', { cause: error }),
      ),
      TE.chain((data) => (data ? TE.right(JSON.parse(data) as readonly Event[]) : TE.right([]))),
    );

  const setEvents = (events: readonly Event[]): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => redis.set(cacheKey, JSON.stringify(events)),
        (error) => new APIError('Cache error', { cause: error }),
      ),
    );

  return {
    getEvents,
    setEvents,
  };
};
```

## Workflow Implementation

Complex business workflows in `workflow.ts`:

```typescript
export interface EventWorkflow {
  readonly syncEvents: () => TE.TaskEither<APIError, void>;
}

export const createEventWorkflow = (
  bootstrapApi: BootstrapApi,
  eventRepository: EventRepository,
  eventCache: EventCache,
): EventWorkflow => {
  const syncEvents = (): TE.TaskEither<APIError, void> =>
    pipe(
      bootstrapApi.getEvents(),
      TE.chain((events) =>
        pipe(
          events,
          A.map((event) => upsertEvent(event)),
          TE.sequenceArray,
        ),
      ),
      TE.map(() => undefined),
    );

  const upsertEvent = (event: EventResponse): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => eventRepository.upsert(toPrismaEvent(toDomainEvent(event))),
        (error) => new APIError('Failed to upsert event', { cause: error }),
      ),
      TE.chain(() => eventCache.set(toDomainEvent(event))),
    );

  return { syncEvents };
};
```

Key principles demonstrated in the Events service:

- Pure function composition with fp-ts
- Dependency injection through factory functions
- TaskEither for error handling
- Immutable data structures
- Clear separation of concerns
- Type-safe operations
- Cache integration with domain layer
