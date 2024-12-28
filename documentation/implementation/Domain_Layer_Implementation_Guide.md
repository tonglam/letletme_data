# Domain Layer Implementation Guide

## Table of Contents

- [Domain Layer Implementation Guide](#domain-layer-implementation-guide)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [File Structure](#file-structure)
  - [Types and Models](#types-and-models)
  - [Domain Operations](#domain-operations)
  - [Repository Interface](#repository-interface)
  - [Cache Interface](#cache-interface)

## Overview

This guide demonstrates how to implement a domain layer following functional programming principles using fp-ts. The Events domain serves as our reference implementation.

## File Structure

```
src/domains/{domain-name}/
├── operations.ts  # Pure domain operations using fp-ts
├── repository.ts  # Repository interface implementation
└── cache.ts      # Cache interface implementation
```

## Types and Models

All domain types should be defined in `src/types/{domain-name}.type.ts`:

```typescript
// Branded type for type-safe IDs
export type EventId = Branded<number, 'EventId'>;

// Domain model
export interface Event {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: Date;
  // ... other properties
}

// Repository interface
export interface EventRepository extends BaseRepository<PrismaEvent, PrismaEventCreate, EventId> {
  readonly findCurrent: () => Promise<PrismaEvent | null>;
  readonly findNext: () => Promise<PrismaEvent | null>;
}

// Type converters
export const toDomainEvent = (data: EventResponse | PrismaEvent): Event => ({
  id: data.id as EventId,
  name: data.name,
  deadlineTime: new Date(data.deadlineTime),
  // ... convert other properties
});

export const toPrismaEvent = (event: Event): PrismaEventCreate => ({
  id: Number(event.id),
  name: event.name,
  deadlineTime: event.deadlineTime,
  // ... convert other properties
});
```

## Domain Operations

Pure functions using fp-ts for type-safe error handling and composition:

```typescript
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { withCache, withValidatedCache } from '../../infrastructure/cache/utils';

export const findAllEvents = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, readonly Event[]> =>
  pipe(
    withCache(
      () => cache.getAllEvents(),
      () =>
        pipe(
          repository.findAll(),
          TE.mapLeft(toAPIError),
          TE.map((events) => events.map(toDomainEvent)),
        ),
      (events) => cache.cacheEvents(events),
    ),
    TE.mapLeft(toAPIError),
  );

export const findEventById = (
  repository: EventRepository,
  cache: EventCache,
  id: EventId,
): TE.TaskEither<APIError, Event | null> =>
  pipe(
    withValidatedCache(
      (id: string) => validateEventId(Number(id)),
      (validId) => cache.getEvent(String(validId)),
      (validId) =>
        pipe(
          repository.findById(validId),
          TE.mapLeft(toAPIError),
          TE.map((event) => (event ? toDomainEvent(event) : null)),
        ),
      (event) => cache.cacheEvent(event),
    )(String(id)),
    TE.mapLeft(toAPIError),
  );
```

## Repository Interface

Define repository operations that return Promises:

```typescript
export interface EventRepository {
  readonly findAll: () => Promise<PrismaEvent[]>;
  readonly findById: (id: EventId) => Promise<PrismaEvent | null>;
  readonly findCurrent: () => Promise<PrismaEvent | null>;
  readonly findNext: () => Promise<PrismaEvent | null>;
  readonly save: (data: PrismaEventCreate) => Promise<PrismaEvent>;
  readonly saveBatch: (data: PrismaEventCreate[]) => Promise<PrismaEvent[]>;
  readonly deleteAll: () => Promise<void>;
}
```

## Cache Interface

Define cache operations using TaskEither for error handling:

```typescript
export interface EventCache {
  readonly getEvent: (id: string) => TE.TaskEither<APIError, Event | null>;
  readonly getAllEvents: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly cacheEvent: (event: Event | null) => TE.TaskEither<APIError, void>;
  readonly cacheEvents: (events: readonly Event[]) => TE.TaskEither<APIError, void>;
  readonly warmUp: () => TE.TaskEither<APIError, void>;
}
```

Key principles demonstrated in the Events domain:

- Pure functions with explicit dependencies
- TaskEither for type-safe error handling
- Immutable data structures with readonly properties
- Function composition using pipe
- Separation of domain logic from infrastructure concerns
- Branded types for type safety
- Cache-first architecture with repository fallback
