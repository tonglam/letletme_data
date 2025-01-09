# Domain Layer Implementation Guide

## Overview

This guide demonstrates how to implement a domain layer following functional programming principles and Domain-Driven Design (DDD) patterns. The guide uses the Events domain as a reference implementation.

## File Structure

A domain implementation requires the following files:

```plaintext
src/domain/{domain-name}/
├── types.ts       # Domain-specific interfaces and types
├── operation.ts   # High-level domain operations
├── repository.ts  # Data access layer
├── cache.ts      # Caching layer
└── utils.ts      # Domain-specific utilities and helpers
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
  readonly cacheEvents: (events: readonly Event[]) => TaskEither<CacheError, void>;
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

// Cache configuration
export interface EventCacheConfig {
  readonly keyPrefix: string;
  readonly season: number;
}

// Data provider for cache
export interface EventDataProvider {
  readonly getOne: (id: number) => Promise<Event | null>;
  readonly getAll: () => Promise<Event[]>;
  readonly getCurrentEvent: () => Promise<Event | null>;
  readonly getNextEvent: () => Promise<Event | null>;
}
```

## Repository Implementation

```typescript
// Repository implementation with Prisma
export const eventRepository: EventRepositoryOperations = {
  findAll: (): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findMany({ orderBy: { id: 'asc' } }),
        (error) => handlePrismaError('Failed to fetch all events', error),
      ),
    ),

  findById: (id: EventId): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findUnique({ where: { id: Number(id) } }),
        (error) => handlePrismaError(`Failed to fetch event ${id}`, error),
      ),
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
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const parseEvent = (eventStr: string): E.Either<CacheError, Event | null> =>
    pipe(
      E.tryCatch(
        () => JSON.parse(eventStr),
        (error) => createError('Failed to parse event JSON', error),
      ),
      E.chain((parsed) =>
        parsed && typeof parsed === 'object' && 'id' in parsed
          ? E.right(parsed as Event)
          : E.right(null),
      ),
    );

  const cacheEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(baseKey, event.id.toString(), JSON.stringify(event)),
        (error) => createError('Failed to cache event', error),
      ),
      TE.map(() => undefined),
    );

  const cacheEvents = (events: readonly Event[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (events.length === 0) return;

          // Delete base key before caching
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();

          // Cache all events in a single transaction
          const cacheMulti = redisClient.multi();
          events.forEach((event) => {
            cacheMulti.hset(baseKey, event.id.toString(), JSON.stringify(event));
          });
          await cacheMulti.exec();
        },
        (error) => createError('Failed to cache events', error),
      ),
    );

  // ... other cache methods
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
      getOne: repository.findById,
      getAll: repository.findAll,
      getCurrentEvent: repository.findCurrent,
      getNextEvent: repository.findNext,
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
// Error creation
const createError = (message: string, cause?: unknown): CacheError =>
  createCacheOperationError({ message, cause });

// Repository error handling
const handleRepositoryError = (message: string) => (error: unknown) =>
  createStandardDomainError({
    code: DomainErrorCode.VALIDATION_ERROR,
    message,
    details: error,
  });

// Cache error mapping
const mapCacheError = (message: string) => (error: unknown) =>
  createStandardDomainError({
    code: DomainErrorCode.PROCESSING_ERROR,
    message,
    details: error,
  });

// Error mapping helper
const withCacheErrorMapping = <T>(message: string, task: TE.TaskEither<unknown, T>) =>
  pipe(task, TE.mapLeft(mapCacheError(message)));
```

## Best Practices

1. **Type Safety**

   - Use branded types for domain identifiers
   - Make all properties readonly
   - Avoid any type
   - Use strict type checking
   - Validate data at domain boundaries

2. **Error Handling**

   - Use TaskEither for all async operations
   - Define specific error types
   - Handle errors explicitly at domain boundaries
   - Provide meaningful error messages
   - Use error mapping for consistent error types

3. **Functional Programming**

   - Use pure functions
   - Compose operations with pipe
   - Avoid side effects in core logic
   - Use immutable data structures
   - Leverage fp-ts utilities (Option, Either, TaskEither)

4. **Testing**

   - Unit test pure functions
   - Mock external dependencies
   - Test error cases
   - Use property-based testing for validation
   - Test cache and repository layers separately

5. **Performance**

   - Implement caching for frequently accessed data
   - Use batch operations where possible
   - Optimize database queries
   - Monitor performance metrics
   - Use Redis transactions for atomic operations

6. **Caching**
   - Use Redis transactions for atomic operations
   - Handle JSON serialization/deserialization explicitly
   - Clean up stale data before caching
   - Implement proper cache warming
   - Use proper key prefixes and namespacing

## Implementation Steps

1. Define domain types and interfaces in `types.ts`
2. Create repository layer with Prisma
3. Implement cache layer with Redis
4. Add data parsing and validation
5. Implement high-level operations
6. Add comprehensive tests
7. Document public APIs and implementation details

## Common Patterns

1. **Cache-Aside Pattern with Error Handling**

```typescript
const getData = (id: string) =>
  pipe(
    cache.get(id),
    TE.mapLeft(mapCacheError('Failed to get from cache')),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findById(id),
            TE.mapLeft(handleRepositoryError('Failed to fetch from repository')),
            TE.chain((data) =>
              pipe(
                cache.set(id, data),
                TE.mapLeft(mapCacheError('Failed to cache data')),
                TE.map(() => data),
              ),
            ),
          ),
    ),
  );
```

2. **Repository Pattern with Transactions**

```typescript
interface Repository<T, ID> {
  findById: (id: ID) => TaskEither<Error, T | null>;
  findAll: () => TaskEither<Error, T[]>;
  save: (entity: T) => TaskEither<Error, T>;
  saveMany: (entities: readonly T[]) => TaskEither<Error, T[]>;
  transaction: <R>(operations: (tx: Transaction) => Promise<R>) => TaskEither<Error, R>;
}
```

3. **Cache Pattern with Redis Transactions**

```typescript
const cacheMany = (entities: readonly T[]): TaskEither<CacheError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        const multi = redisClient.multi();
        multi.del(baseKey);
        await multi.exec();

        const cacheMulti = redisClient.multi();
        entities.forEach((entity) => {
          cacheMulti.hset(baseKey, entity.id.toString(), JSON.stringify(entity));
        });
        await cacheMulti.exec();
      },
      (error) => createError('Failed to cache entities', error),
    ),
  );
```

4. **Domain Operations Pattern with Error Mapping**

```typescript
interface DomainOperations<T, ID> {
  getById: (id: ID) => TaskEither<DomainError, T | null>;
  getAll: () => TaskEither<DomainError, readonly T[]>;
  create: (entity: T) => TaskEither<DomainError, T>;
  createMany: (entities: readonly T[]) => TaskEither<DomainError, readonly T[]>;
  update: (id: ID, entity: T) => TaskEither<DomainError, T>;
  delete: (id: ID) => TaskEither<DomainError, void>;
}
```
