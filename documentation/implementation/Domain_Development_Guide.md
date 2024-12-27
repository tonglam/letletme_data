# Domain Development Guide

This guide outlines the process of implementing a new domain in the application, using the `events` domain as a reference implementation.

## 1. Domain Structure

### 1.1 Directory Structure

```
src/
├── types/
│   ├── events.type.ts    # Domain types and transformers
│   └── [domain].type.ts  # Each domain has its own type file
├── domains/
│   └── [domain]/
│       ├── operations.ts  # Pure business logic
│       ├── repository.ts  # Data access layer
│       ├── queries.ts     # Business queries
│       └── cache.ts       # Cache operations
```

### 1.2 Layer Responsibilities

#### Types Layer

```typescript
// Branded types for type safety
export type EventId = number & { readonly _brand: unique symbol };

// Domain models
export type Event = {
  readonly id: EventId;
  readonly name: string;
  // ... other fields
};

// Validation functions
export const validateEventId = (id: number): E.Either<string, EventId> =>
  id > 0 ? E.right(id as EventId) : E.left(`Invalid event ID: ${id}`);
```

#### Operations Layer

```typescript
// Pure business logic with explicit error handling
export const saveEvent = (event: DomainEvent): TE.TaskEither<APIError, DomainEvent> =>
  pipe(
    eventRepository.save(single.fromDomain(event)),
    TE.map(single.toDomain),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save event' })),
    ),
  );
```

#### Repository Layer

```typescript
// Data access with explicit error handling
export const eventRepository: EventRepository = {
  save: (event: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent> =>
    TE.tryCatch(
      () => prisma.event.create({ data: event }),
      (error) => createDatabaseError({ message: 'Failed to save event', details: { error } }),
    ),

  findById: (id: EventId): TE.TaskEither<APIError, PrismaEvent | null> =>
    TE.tryCatch(
      () => prisma.event.findUnique({ where: { id: Number(id) } }),
      (error) => createDatabaseError({ message: 'Failed to find event', details: { error } }),
    ),
};
```

#### Queries Layer

```typescript
// Business query operations with validation
export const getEventById = (
  repository: EventRepository,
  id: number,
): TE.TaskEither<APIError, PrismaEvent | null> =>
  pipe(
    validateEventId(id),
    E.mapLeft((message) => createValidationError({ message })),
    TE.fromEither,
    TE.chain(repository.findById),
  );
```

## 2. Implementation Best Practices

### 2.1 Error Handling

```typescript
// Use TaskEither for all async operations
type TaskEither<E, A> = () => Promise<Either<E, A>>;

// Consistent error creation
const createDatabaseError = (params: { message: string; details?: unknown }): APIError => ({
  code: 'DB_ERROR',
  message: params.message,
  details: params.details,
});

// Error transformation in repositories
TE.tryCatch(
  () => prisma.operation(),
  (error) => createDatabaseError({ message: 'Operation failed', details: { error } }),
);
```

### 2.2 Type Safety

```typescript
// Branded types for domain identifiers
type EventId = number & { readonly _brand: unique symbol };

// Validation at boundaries
const validateEventId = (id: number): E.Either<string, EventId> =>
  id > 0 ? E.right(id as EventId) : E.left(`Invalid event ID: ${id}`);

// Type transformations
const toDomainEvent = (prisma: PrismaEvent): DomainEvent => ({
  id: prisma.id as EventId,
  // ... other fields
});
```

### 2.3 Pure Functions

```typescript
// Pure operation with explicit dependencies
const getEventById = (
  repository: EventRepository,
  id: number,
): TE.TaskEither<APIError, PrismaEvent | null> =>
  pipe(
    validateEventId(id),
    E.mapLeft((message) => createValidationError({ message })),
    TE.fromEither,
    TE.chain(repository.findById),
  );
```

## 3. Testing Strategy

### 3.1 Unit Tests

```typescript
describe('Event Operations', () => {
  describe('saveEvent', () => {
    it('should save valid event', async () => {
      const event = createTestEvent();
      const result = await saveEvent(event)();
      expect(E.isRight(result)).toBe(true);
    });

    it('should handle validation errors', async () => {
      const invalidEvent = { ...createTestEvent(), id: -1 };
      const result = await saveEvent(invalidEvent)();
      expect(E.isLeft(result)).toBe(true);
    });
  });
});
```

### 3.2 Integration Tests

```typescript
describe('Event Repository', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('should create and retrieve event', async () => {
    const event = createTestEvent();
    const saved = await eventRepository.save(event)();
    expect(E.isRight(saved)).toBe(true);

    const retrieved = await eventRepository.findById(saved.right.id)();
    expect(E.isRight(retrieved)).toBe(true);
    expect(retrieved.right).toEqual(saved.right);
  });
});
```

## 4. Common Patterns

### 4.1 Repository Pattern

```typescript
export interface EventRepository {
  save(event: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent>;
  findById(id: EventId): TE.TaskEither<APIError, PrismaEvent | null>;
  findAll(): TE.TaskEither<APIError, PrismaEvent[]>;
  update(id: EventId, event: PrismaEventUpdate): TE.TaskEither<APIError, PrismaEvent>;
}
```

### 4.2 Type Transformations

```typescript
const { single, array } = createDomainOperations<DomainEvent, PrismaEvent>({
  toDomain: toDomainEvent,
  toPrisma: toPrismaEvent,
});

export const findAllEvents = (): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(eventRepository.findAll(), TE.map(array.toDomain));
```

### 4.3 Error Handling Pattern

```typescript
const withErrorHandling = <T>(
  operation: () => Promise<T>,
  errorMessage: string,
): TE.TaskEither<APIError, T> =>
  TE.tryCatch(operation, (error) =>
    createDatabaseError({ message: errorMessage, details: { error } }),
  );

const save = (event: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent> =>
  withErrorHandling(() => prisma.event.create({ data: event }), 'Failed to save event');
```
