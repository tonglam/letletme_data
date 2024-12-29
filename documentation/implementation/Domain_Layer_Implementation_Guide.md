# Domain Layer Implementation Guide

## Overview

This guide demonstrates how to implement a domain layer following functional programming principles and Domain-Driven Design (DDD) patterns. The guide uses the Events domain as a reference implementation.

## File Structure

A domain implementation requires the following files:

```
src/
├── domains/
│   └── {domain-name}/
│       ├── types.ts       # Domain-specific type definitions
│       ├── operations.ts  # High-level domain operations
│       ├── repository.ts  # Data access layer
│       └── cache.ts      # Caching layer (optional)
└── types/
    └── {domain-name}.type.ts  # Core domain types and models
```

## Core Domain Types (`src/types/{domain-name}.type.ts`)

1. **Branded Types** for type-safe identifiers:

```typescript
export type EventId = Branded<number, 'EventId'>;

export const createEventId = createBrandedType<number, 'EventId'>(
  'EventId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);
```

2. **Domain Models**:

```typescript
export interface Event {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: Date;
  // ... other properties
}
```

3. **Type Converters**:

```typescript
export const toDomainEvent = (data: EventResponse | PrismaEvent): Event => ({
  id: data.id as EventId,
  name: data.name,
  // ... convert other properties
});

export const toPrismaEvent = (event: Event): PrismaEventCreate => ({
  id: Number(event.id),
  name: event.name,
  // ... convert other properties
});
```

## Domain-Specific Types (`src/domains/{domain-name}/types.ts`)

Define interfaces for domain operations:

```typescript
export interface EventOperations {
  readonly getAllEvents: () => TaskEither<APIError, readonly Event[]>;
  readonly getEventById: (id: EventId) => TaskEither<APIError, Event | null>;
  // ... other operations
}

export interface EventRepositoryOperations {
  readonly findAll: () => TaskEither<APIError, PrismaEvent[]>;
  readonly findById: (id: EventId) => TaskEither<APIError, PrismaEvent | null>;
  // ... other repository operations
}

export interface EventCache {
  readonly cacheEvent: (event: Event) => TaskEither<CacheError, void>;
  readonly getEvent: (id: string) => TaskEither<CacheError, Event | null>;
  // ... other cache operations
}
```

## Repository Implementation (`src/domains/{domain-name}/repository.ts`)

```typescript
export const eventRepository: EventRepository = {
  findAll: (): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(TE.tryCatch(() => prisma.event.findMany(), handlePrismaError)),

  findById: (id: EventId): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(TE.tryCatch(() => prisma.event.findUnique({ where: { id } }), handlePrismaError)),
  // ... other repository methods
};
```

## Operations Implementation (`src/domains/{domain-name}/operations.ts`)

```typescript
export const createEventOperations = (
  repository: EventRepositoryOperations,
  cache: EventCache,
): EventOperations => ({
  getAllEvents: () =>
    withCache(
      () => cache.getAllEvents(),
      () =>
        pipe(
          repository.findAll(),
          TE.map((events) => events.map(toDomainEvent)),
        ),
      (events) => cache.cacheEvents(events),
    ),
  // ... other operations
});
```

## Cache Implementation (`src/domains/{domain-name}/cache.ts`)

```typescript
export const createEventCache = (
  redis: RedisCache<Event>,
  dataProvider: EventDataProvider,
  config: EventCacheConfig,
): EventCache => {
  const makeKey = () => `${config.keyPrefix}::${config.season}`;

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

1. Define core domain types in `src/types/{domain-name}.type.ts`
2. Create domain-specific interfaces in `src/domains/{domain-name}/types.ts`
3. Implement repository layer with Prisma
4. Add cache layer if needed
5. Implement high-level operations
6. Add tests for all components
7. Document public APIs and important implementation details

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
