# Domain Layer Implementation Guide

## Overview

The domain layer represents the core business logic of our FPL data service. Following Domain-Driven Design (DDD) principles and Functional Programming (FP) patterns, each domain is self-contained and implements pure business logic with explicit error handling.

## Core Design Philosophy

### Domain-Driven Design Choice

The choice of DDD stems from the inherent complexity of FPL data management:

1. **Complex Domain Logic**

   - Intricate business rules around game weeks, player values, and team management
   - DDD helps model these complexities explicitly
   - Makes the system more maintainable and adaptable to changes

2. **Natural Domain Boundaries**

   - FPL naturally divides into distinct domains (events, teams, players, entries)
   - Each domain has its own lifecycle and rules
   - DDD's bounded contexts map perfectly to these divisions

3. **Data Evolution Management**
   - FPL data constantly evolves throughout the season
   - Domain models help manage this evolution
   - Maintains data consistency and historical tracking

### Functional Programming Integration

FP principles are core to our implementation:

1. **TaskEither for Error Handling**

   - All operations return TaskEither for explicit error handling
   - Clear separation between success and failure paths
   - Composable error handling with fp-ts

2. **Pure Functions**

   - Business logic implemented as pure functions
   - Operations are side-effect free
   - Easier to test and maintain

3. **Type Safety**
   - Branded types for domain identifiers
   - Strict validation at domain boundaries
   - No implicit type coercion

## Domain Structure

Each domain follows a consistent four-file structure:

### 1. Operations (operations.ts)

```typescript
// Pure business logic functions
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

### 2. Repository (repository.ts)

```typescript
// Data access layer with explicit error handling
export const eventRepository: EventRepository = {
  save: (event: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent> =>
    TE.tryCatch(
      () => prisma.event.create({ data: event }),
      (error) => createDatabaseError({ message: 'Failed to save event', details: { error } }),
    ),
};
```

### 3. Queries (queries.ts)

```typescript
// Business query operations
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

### 4. Types (types.ts)

```typescript
// Domain types and validations
export type EventId = number & { readonly _brand: unique symbol };
export const validateEventId = (id: number): E.Either<string, EventId> =>
  id > 0 ? E.right(id as EventId) : E.left(`Invalid event ID: ${id}`);
```

## Implementation Guidelines

### 1. Domain Isolation

- Self-contained domains with explicit interfaces
- Clear dependencies through repository pattern
- No cross-domain knowledge leakage
- Pure functional core with side effects at edges

### 2. Type Safety

- Branded types for domain identifiers
- Explicit validation at boundaries
- No implicit type coercion
- Comprehensive type definitions

### 3. Error Handling

- TaskEither for all operations
- Explicit error types and messages
- Consistent error creation patterns
- Error transformation at boundaries

## Testing Strategy

### 1. Unit Tests

- Pure operations testing
- Error handling scenarios
- Type validation
- Business rule verification

### 2. Integration Tests

- Repository operations
- Database interactions
- Error propagation
- Transaction handling

### 3. Property Tests

- Input validation
- Business rule invariants
- Error conditions
- Edge cases

## Best Practices

### 1. Code Organization

- Consistent file structure
- Clear module boundaries
- Explicit dependencies
- Functional composition

### 2. Performance

- Efficient data access patterns
- Transaction management
- Error handling optimization
- Type-safe transformations

### 3. Maintainability

- Pure functions
- Explicit error handling
- Clear type boundaries
- Comprehensive documentation
