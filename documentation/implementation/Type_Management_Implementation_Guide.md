# Type Management Implementation Guide

## Overview

This guide demonstrates how to implement a type system following functional programming principles using fp-ts and zod. The guide uses the Events type system as a reference implementation.

## File Structure

```plaintext
src/types/
├── base.type.ts         # Core type system and utilities
├── errors.type.ts       # Error type hierarchy
├── {domain}.type.ts     # Domain-specific types
└── validation.type.ts   # Validation utilities
```

## Core Type System

### 1. Branded Types (`base.type.ts`)

```typescript
// Brand interface for type branding
export interface Brand<K extends string> {
  readonly __brand: K;
}

// Branded type combining a base type with a brand
export type Branded<T, K extends string> = T & Brand<K>;

// Creates a branded type with validation
export const createBrandedType = <T, K extends string>(
  brand: K,
  validator: (value: unknown) => value is T,
) => ({
  validate: (value: unknown): E.Either<string, Branded<T, K>> =>
    validator(value) ? E.right(value as Branded<T, K>) : E.left(`Invalid ${brand}: ${value}`),
  is: (value: unknown): value is Branded<T, K> => validator(value),
});
```

### 2. Base Repository Interface

```typescript
export interface BaseRepository<T, CreateT, IdT> {
  readonly findAll: () => TE.TaskEither<DBError, T[]>;
  readonly findById: (id: IdT) => TE.TaskEither<DBError, T | null>;
  readonly save: (data: CreateT) => TE.TaskEither<DBError, T>;
  readonly saveBatch: (data: CreateT[]) => TE.TaskEither<DBError, T[]>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
  readonly deleteByIds: (ids: IdT[]) => TE.TaskEither<DBError, void>;
}
```

### 3. Schema Validation

```typescript
export const validateSchema =
  <T>(schema: z.Schema<T>, entityName: string) =>
  (data: unknown): E.Either<string, T> => {
    const result = schema.safeParse(data);
    if (result.success) {
      return E.right(result.data);
    }
    const error = result as z.SafeParseError<T>;
    return E.left(
      `Invalid ${entityName} domain model: ${error.error.errors[0]?.message || 'Unknown error'}`,
    );
  };
```

## Domain Types Implementation

Using Events as an example (`events.type.ts`):

### 1. Domain ID Type

```typescript
// Branded type for Event ID
export type EventId = Branded<number, 'EventId'>;

// Creates a branded EventId with validation
export const createEventId = createBrandedType<number, 'EventId'>(
  'EventId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

// Validates and converts a value to EventId
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

### 2. API Response Types

```typescript
// Zod schemas for nested types
export const TopElementInfoSchema = z.object({
  id: z.number(),
  points: z.number(),
});

export const ChipPlaySchema = z.object({
  chip_name: z.string(),
  num_played: z.number(),
});

// Schema for validating event response data
export const EventResponseSchema = z
  .object({
    // Required fields
    id: z.number(),
    name: z.string(),
    deadline_time: z.string(),
    deadline_time_epoch: z.number(),
    finished: z.boolean(),
    is_previous: z.boolean(),
    is_current: z.boolean(),
    is_next: z.boolean(),

    // Fields with defaults
    deadline_time_game_offset: z.number().default(0),
    average_entry_score: z.number().default(0),
    data_checked: z.boolean().default(false),

    // Optional fields
    release_time: z.string().nullable().optional(),
    chip_plays: z.array(ChipPlaySchema).default([]),
    top_element_info: TopElementInfoSchema.nullable().optional(),
  })
  .passthrough();

export type EventResponse = z.infer<typeof EventResponseSchema>;
```

### 3. Domain Model

```typescript
export interface Event {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: string | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly chipPlays: readonly ChipPlay[];
  readonly topElementInfo: TopElementInfo | null;
}
```

### 4. Database Model

```typescript
export interface PrismaEvent {
  readonly id: number;
  readonly name: string;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: string | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly chipPlays: Prisma.JsonValue | null;
  readonly topElementInfo: Prisma.JsonValue | null;
  readonly createdAt: Date;
}

export type PrismaEventCreate = Omit<PrismaEvent, 'createdAt'>;
```

### 5. Type Converters

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
    deadlineTime: isEventApiResponse(data) ? data.deadline_time : data.deadlineTime,
    // ... other field conversions
  };
};
```

## Best Practices

### 1. Type Safety

```typescript
// Use branded types for IDs
type UserId = Branded<number, 'UserId'>;

// Validate at runtime
const validateUser = (data: unknown): E.Either<string, User> =>
  pipe(
    UserSchema.safeParse(data),
    E.fromPredicate(
      (result): result is z.SafeParseSuccess<User> => result.success,
      (error) => `Invalid user: ${error}`,
    ),
    E.map((result) => result.data),
  );
```

### 2. Error Handling

```typescript
// Define specific error types
interface ValidationError extends Error {
  readonly code: 'VALIDATION_ERROR';
  readonly details: z.ZodError;
}

// Use Either for sync operations
const validateId = (id: unknown): E.Either<ValidationError, UserId> =>
  pipe(
    id,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => new ValidationError('Invalid ID'),
    ),
  );
```

### 3. Type Guards

```typescript
// Type guard for API responses
export const isApiResponse = <T extends object, K extends string>(
  data: T,
  snakeCaseKey: K,
): data is T & Record<K, unknown> => snakeCaseKey in data;

// Type guard for domain models
const isDomainEvent = (value: unknown): value is Event =>
  value !== null && typeof value === 'object' && 'id' in value && createEventId.is(value.id);
```

## Common Patterns

### 1. Validation Pattern

```typescript
const validateData =
  <T>(schema: z.Schema<T>) =>
  (data: unknown): E.Either<string, T> =>
    pipe(
      schema.safeParse(data),
      E.fromPredicate(
        (result): result is z.SafeParseSuccess<T> => result.success,
        (error) => `Validation failed: ${error}`,
      ),
      E.map((result) => result.data),
    );
```

### 2. Type Conversion Pattern

```typescript
const convertType =
  <From, To>(converter: (value: From) => To, validator: (value: To) => boolean) =>
  (value: From): E.Either<string, To> =>
    pipe(
      value,
      converter,
      E.fromPredicate(validator, () => 'Conversion validation failed'),
    );
```

### 3. Repository Pattern

```typescript
const createRepository = <T, CreateT, IdT>(
  prisma: PrismaClient,
  converter: (data: PrismaModel) => T,
): BaseRepository<T, CreateT, IdT> => ({
  findAll: () =>
    pipe(
      TE.tryCatch(() => prisma.model.findMany(), handlePrismaError),
      TE.map((items) => items.map(converter)),
    ),
  // ... other operations
});
```
