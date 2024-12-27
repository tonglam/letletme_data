# Type Implementation Guide

This guide outlines the patterns and best practices for implementing types in our codebase.

## File Structure

Each type file should follow this structure:

```typescript
// ============ Branded Types ============
// Type-safe identifiers

// ============ Types ============
// API Response types (snake_case)
// Domain models (camelCase)

// ============ Repository Interface ============
// Database access patterns

// ============ Persistence Types ============
// Database models

// ============ Converters ============
// Conversion functions between types
```

## API Response Types

### 1. Standard Response Format

All API responses follow a consistent format:

```typescript
// Success Response
export interface APIResponse<T> {
  readonly status: 'success';
  readonly data: T;
}

// Error Response
export interface ErrorResponse {
  readonly status: 'error';
  readonly error: string;
}
```

### 2. Response Formatting

Response formatting is handled by utility functions:

```typescript
// Format successful response
const formatResponse = <T>(data: T): APIResponse<T> => ({
  status: 'success',
  data,
});

// Format error response
const formatErrorResponse = (error: Error | string): ErrorResponse => ({
  status: 'error',
  error: typeof error === 'string' ? error : error.message,
});
```

### 3. Usage with fp-ts

Responses are typically formatted using fp-ts pipes:

```typescript
const result = await pipe(
  service.operation(),
  TE.map(formatResponse),
  TE.mapLeft(formatErrorResponse),
)();
```

## Type Categories

### 1. API Response Types

```typescript
export interface PhaseResponse {
  readonly id: number;
  readonly name: string;
  readonly start_event: number;
  readonly stop_event: number;
  readonly highest_score: number | null;
}
```

### 2. Domain Types

```typescript
export interface Phase {
  readonly id: PhaseId;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
}
```

### 3. Persistence Types

```typescript
export interface PrismaPhase {
  readonly id: number;
  readonly createdAt: Date;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
}

export type PrismaPhaseCreate = Omit<PrismaPhase, 'id' | 'createdAt'>;
```

## Best Practices

1. Make all fields readonly
2. Use branded types for IDs
3. Use snake_case for API types, camelCase for domain types
4. Use shared type guards for API responses
5. Keep conversion logic simple and direct

## Type Guards

```typescript
// Branded type validator
export const PhaseId = createBrandedType<number, 'PhaseId'>(
  'PhaseId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

// API response type guard
export const toDomainPhase = (data: PhaseResponse | PrismaPhase): Phase => {
  const isPhaseApiResponse = (d: PhaseResponse | PrismaPhase): d is PhaseResponse =>
    isApiResponse(d, 'start_event');

  return {
    id: data.id as PhaseId,
    name: data.name,
    startEvent: isPhaseApiResponse(data) ? data.start_event : data.startEvent,
    stopEvent: isPhaseApiResponse(data) ? data.stop_event : data.stopEvent,
    highestScore: isPhaseApiResponse(data) ? data.highest_score : data.highestScore,
  };
};
```
