# Type Management Guide

## Table of Contents

- [Type Management Guide](#type-management-guide)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [File Structure](#file-structure)
  - [Type Categories](#type-categories)
  - [Branded Types](#branded-types)
  - [Domain Models](#domain-models)
  - [API Types](#api-types)
  - [Repository Types](#repository-types)
  - [Type Converters](#type-converters)
  - [Service Types](#service-types)

## Overview

This guide demonstrates how to manage types in the project following functional programming principles. The Events type system serves as our reference implementation.

## File Structure

```
src/types/
├── base.type.ts         # Base types and utilities
├── {domain-name}.type.ts # Domain-specific types
└── bootstrap.type.ts    # External API types
```

## Type Categories

Types should be organized into clear categories:

```typescript
// Branded types for type safety
export type EventId = Branded<number, 'EventId'>;

// Domain models
export interface Event { ... }

// API response types
export interface EventResponse { ... }

// Repository types
export interface EventRepository { ... }

// Service interfaces
export interface EventService { ... }

// Cache interfaces
export interface EventCache { ... }
```

## Branded Types

Use branded types for type-safe identifiers:

```typescript
import { Branded } from './base.type';

// Type definition
export type EventId = Branded<number, 'EventId'>;

// Type creator with validation
export const createEventId = createBrandedType<number, 'EventId'>(
  'EventId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

// Validator function
export const validateEventId = (value: unknown): E.Either<string, EventId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid event ID: must be a positive integer',
    ),
    E.map((v) => v as EventId),
  );
```

## Domain Models

Define domain models with immutable properties and proper types:

```typescript
export interface Event {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: Date;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: Date | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly highestScore: number;
  readonly highestScoringEntry: number;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly chipPlays: readonly ChipPlay[];
  readonly topElementInfo: TopElementInfo | null;
}

// Nested types should also be immutable
export interface ChipPlay {
  readonly chip_name: string;
  readonly num_played: number;
}

export interface TopElementInfo {
  readonly id: number;
  readonly points: number;
}
```

## API Types

Define types that match external API responses:

```typescript
export interface EventResponse {
  readonly id: number;
  readonly name: string;
  readonly deadline_time: string;
  readonly deadline_time_epoch: number;
  readonly deadline_time_game_offset: number;
  readonly release_time: string | null;
  readonly average_entry_score: number;
  readonly finished: boolean;
  readonly data_checked: boolean;
  readonly highest_score: number;
  readonly highest_scoring_entry: number;
  readonly is_previous: boolean;
  readonly is_current: boolean;
  readonly is_next: boolean;
  readonly chip_plays: readonly ChipPlay[];
  readonly top_element_info: TopElementInfo | null;
}

export type EventsResponse = readonly EventResponse[];
```

## Repository Types

Define repository types with Prisma integration:

```typescript
// Base repository interface
export interface BaseRepository<T, CreateT, IdT> {
  readonly findAll: () => Promise<T[]>;
  readonly findById: (id: IdT) => Promise<T | null>;
  readonly save: (data: CreateT) => Promise<T>;
  readonly saveBatch: (data: CreateT[]) => Promise<T[]>;
  readonly deleteAll: () => Promise<void>;
}

// Domain-specific repository interface
export interface EventRepository extends BaseRepository<PrismaEvent, PrismaEventCreate, EventId> {
  readonly findCurrent: () => Promise<PrismaEvent | null>;
  readonly findNext: () => Promise<PrismaEvent | null>;
}

// Prisma model types
export interface PrismaEvent {
  readonly id: number;
  readonly name: string;
  readonly deadlineTime: Date;
  readonly chipPlays: Prisma.JsonValue;
  readonly topElementInfo: Prisma.JsonValue | null;
  readonly createdAt: Date;
}

export type PrismaEventCreate = Omit<PrismaEvent, 'createdAt'>;
```

## Type Converters

Implement type converters for transforming between different type representations:

```typescript
export const toDomainEvent = (data: EventResponse | PrismaEvent): Event => {
  const isEventApiResponse = (d: EventResponse | PrismaEvent): d is EventResponse =>
    isApiResponse(d, 'deadline_time');

  const parseChipPlay = (item: Prisma.JsonObject): ChipPlay => ({
    chip_name: String(item.chip_name || ''),
    num_played: Number(item.num_played || 0),
  });

  return {
    id: data.id as EventId,
    name: data.name,
    deadlineTime: isEventApiResponse(data) ? new Date(data.deadline_time) : data.deadlineTime,
    chipPlays: isEventApiResponse(data)
      ? data.chip_plays
      : parseJsonArray(data.chipPlays, parseChipPlay),
    // ... other conversions
  };
};

export const toPrismaEvent = (event: Event): PrismaEventCreate => ({
  id: Number(event.id),
  name: event.name,
  deadlineTime: event.deadlineTime,
  chipPlays: event.chipPlays as unknown as Prisma.JsonValue,
  // ... other conversions
});
```

## Service Types

Define service interfaces with TaskEither for error handling:

```typescript
export interface EventService {
  readonly warmUp: () => TE.TaskEither<APIError, void>;
  readonly getEvents: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<APIError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;
}

export interface EventServiceDependencies {
  readonly bootstrapApi: BootstrapApi;
  readonly eventCache: EventCache;
  readonly eventRepository: EventRepository;
}
```

Key principles demonstrated in the Events type system:

- Branded types for type safety
- Immutable data structures with readonly properties
- Clear type hierarchies and organization
- Proper type conversions between layers
- Integration with external types (Prisma, API)
- TaskEither for functional error handling
- Type predicates for type narrowing
- JSON parsing with type safety
