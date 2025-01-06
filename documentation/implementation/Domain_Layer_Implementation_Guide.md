# Domain Layer Implementation Guide

## Overview

This guide demonstrates how to implement a domain layer following functional programming principles and Domain-Driven Design (DDD) patterns. The guide uses the Events domain as a reference implementation.

## File Structure

A domain implementation requires the following files:

```plaintext
src/domain/{domain-name}/
├── types.ts       # Domain-specific interfaces and types
├── operation.ts  # High-level domain operations
├── repository.ts  # Data access layer
└── cache.ts      # Caching layer
```

## Core Domain Types

1. **Domain Interfaces** (`types.ts`):

```typescript
// Repository operations
export interface EventRepositoryOperations {
  readonly findAll: () => TaskEither<DBError, PrismaEvent[]>;
  readonly findById: (id: EventId) => TaskEither<DBError, PrismaEvent | null>;
  readonly findCurrent: () => TaskEither<DBError, PrismaEvent | null>;
  readonly findNext: () => TaskEither<DBError, PrismaEvent | null>;
  readonly create: (event: Event) => TaskEither<DBError, PrismaEvent>;
  readonly createMany: (events: readonly Event[]) => TaskEither<DBError, PrismaEvent[]>;
  readonly deleteAll: () => TaskEither<DBError, void>;
}

// Cache operations
export interface EventCache {
  readonly warmUp: () => TaskEither<CacheError, void>;
  readonly cacheEvent: (event: Event) => TaskEither<CacheError, void>;
  readonly getEvent: (id: string) => TaskEither<CacheError, Event | null>;
  readonly getAllEvents: () => TaskEither<CacheError, readonly Event[]>;
  readonly getCurrentEvent: () => TaskEither<CacheError, Event | null>;
  readonly getNextEvent: () => TaskEither<CacheError, Event | null>;
}

// Domain operations
export interface EventOperations {
  readonly getAllEvents: () => TaskEither<DomainError, readonly Event[]>;
  readonly getEventById: (id: EventId) => TaskEither<DomainError, Event | null>;
  readonly getCurrentEvent: () => TaskEither<DomainError, Event | null>;
  readonly getNextEvent: () => TaskEither<DomainError, Event | null>;
  readonly createEvent: (event: Event) => TaskEither<DomainError, Event>;
  readonly createEvents: (events: readonly Event[]) => TaskEither<DomainError, readonly Event[]>;
  readonly deleteAll: () => TaskEither<DomainError, void>;
}
```

## Repository Implementation

```typescript
// Repository implementation with Prisma
export const eventRepository: EventRepositoryOperations = {
  findAll: (): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(TE.tryCatch(() => prisma.event.findMany({ orderBy: { id: 'asc' } }), handlePrismaError)),

  findById: (id: EventId): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(() => prisma.event.findUnique({ where: { id: Number(id) } }), handlePrismaError),
    ),

  // ... other repository methods
};
```

## Cache Implementation

```typescript
export const createEventCache = (
  redis: RedisCache<Event>,
  dataProvider: EventDataProvider,
  config: EventCacheConfig,
): EventCache => {
  const makeKey = (id?: string) =>
    id ? `${config.keyPrefix}::${config.season}::${id}` : `${config.keyPrefix}::${config.season}`;

  return {
    cacheEvent: (event: Event): TE.TaskEither<CacheError, void> =>
      redis.hSet(makeKey(), event.id.toString(), event),

    getEvent: (id: string): TE.TaskEither<CacheError, Event | null> =>
      pipe(
        redis.hGet(makeKey(), id),
        TE.chain((cached) =>
          cached
            ? TE.right(cached)
            : pipe(
                withCacheErrorHandling(
                  () => dataProvider.getOne(Number(id) as EventId),
                  `Failed to fetch event ${id}`,
                ),
                TE.chain((event) =>
                  event
                    ? pipe(
                        cacheEvent(event),
                        TE.map(() => event),
                      )
                    : TE.right(null),
                ),
              ),
        ),
      ),
    // ... other cache methods
  };
};
```

## Domain Operations

```typescript
export const createEventOperations = (repository: EventRepositoryOperations): EventOperations => {
  const redis = createRedisCache<Event>({
    defaultTTL: DefaultTTL.EVENT,
  });

  const cache = createEventCache(
    redis,
    {
      getOne: async () => null,
      getAll: async () => [],
      getCurrentEvent: async () => null,
      getNextEvent: async () => null,
    },
    {
      keyPrefix: CachePrefix.EVENT,
      season: getCurrentSeason(),
    },
  );

  return {
    getAllEvents: () =>
      pipe(
        cache.getAllEvents(),
        TE.mapLeft(mapCacheError('Failed to get events from cache')),
        TE.chain((cachedEvents) =>
          cachedEvents.length > 0
            ? TE.right(cachedEvents)
            : pipe(
                repository.findAll(),
                TE.mapLeft(handleRepositoryError('Failed to fetch all events')),
                TE.map((events) => events.map(toDomainEvent)),
                TE.chainFirst((events) =>
                  withCacheErrorMapping('Failed to cache events', cache.cacheEvents(events)),
                ),
              ),
        ),
      ),
    // ... other operations
  };
};
```

## Error Handling

```typescript
const handleRepositoryError = (message: string) => (error: unknown) =>
  createStandardDomainError({
    code: DomainErrorCode.VALIDATION_ERROR,
    message,
    details: error,
  });

const mapCacheError = (message: string) => (error: unknown) =>
  createStandardDomainError({
    code: DomainErrorCode.PROCESSING_ERROR,
    message,
    details: error,
  });

const withCacheErrorMapping = <T>(message: string, task: TE.TaskEither<unknown, T>) =>
  pipe(task, TE.mapLeft(mapCacheError(message)));
```

## Best Practices

1. **Type Safety**

   - Use branded types for domain identifiers
   - Make all properties readonly
   - Avoid any type
   - Use strict type checking

2. **Error Handling**

   - Use TaskEither for all async operations
   - Define specific error types
   - Handle errors explicitly at domain boundaries
   - Provide meaningful error messages

3. **Functional Programming**

   - Use pure functions
   - Compose operations with pipe
   - Avoid side effects in core logic
   - Use immutable data structures

4. **Testing**

   - Unit test pure functions
   - Mock external dependencies
   - Test error cases
   - Use property-based testing for validation

5. **Performance**
   - Implement caching for frequently accessed data
   - Use batch operations where possible
   - Optimize database queries
   - Monitor performance metrics

## Implementation Steps

1. Define domain types in `types.ts`
2. Create repository layer with Prisma
3. Add cache layer if needed
4. Implement high-level operations
5. Add tests for all components
6. Document public APIs and important implementation details

## Common Patterns

1. **Cache-Aside Pattern**

```typescript
const getData = (id: string) =>
  pipe(
    cache.get(id),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findById(id),
            TE.chain((data) =>
              pipe(
                cache.set(id, data),
                TE.map(() => data),
              ),
            ),
          ),
    ),
  );
```

2. **Repository Pattern**

```typescript
interface Repository<T, ID> {
  findById: (id: ID) => TaskEither<Error, T | null>;
  findAll: () => TaskEither<Error, T[]>;
  save: (entity: T) => TaskEither<Error, T>;
  // ... other methods
}
```

3. **Domain Operations Pattern**

```typescript
interface DomainOperations<T, ID> {
  getById: (id: ID) => TaskEither<Error, T | null>;
  getAll: () => TaskEither<Error, readonly T[]>;
  create: (entity: T) => TaskEither<Error, T>;
  // ... other operations
}
```
