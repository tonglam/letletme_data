# API Layer Implementation Guide

## Overview

The API layer serves as the interface between external clients and the application's domain logic. It handles HTTP routing, request/response formatting, and protocol-specific concerns.

## Directory Structure

```
src/api/
├── routes/           # Route handlers for different domains
│   ├── events/       # Event-related routes
│   ├── phases/       # Phase-related routes
│   └── ...
├── middleware/       # Express middleware
└── responses/        # Response formatting and types
```

## Design Principles

### 1. Separation of Concerns

- Routes only handle HTTP-specific logic
- Business logic remains in domain and service layers
- Response formatting is consistent across endpoints

### 2. Dependency Injection

- External dependencies (FPL client, services) are injected
- Makes testing and configuration easier
- Follows inversion of control principle

### 3. Functional Programming

- Uses fp-ts for error handling and data transformation
- Consistent error handling with Either types
- Pure functions for response formatting

### 4. Type Safety

- Strong typing for requests and responses
- Runtime validation of inputs
- Compile-time safety for API responses

## Response Format

### Success Response

```typescript
{
  status: 'success',
  data: T  // Generic type parameter
}
```

### Error Response

```typescript
{
  status: 'error',
  error: string
}
```

## Route Implementation Pattern

```typescript
const createRouter = (dependencies: Dependencies): Router => {
  const router = Router();

  router.get('/', async (req, res) => {
    const result = await pipe(
      service.operation(),
      TE.map(formatResponse),
      TE.mapLeft(formatErrorResponse),
    )();

    if (E.isLeft(result)) {
      res.status(400).json(result.left);
    } else {
      res.json(result.right);
    }
  });

  return router;
};
```

## Best Practices

1. **Route Organization**

   - Group routes by domain
   - Use descriptive route names
   - Follow RESTful conventions

2. **Error Handling**

   - Consistent error responses
   - Proper HTTP status codes
   - Detailed error messages

3. **Validation**

   - Validate all inputs
   - Use domain types and validators
   - Clear validation error messages

4. **Response Formatting**
   - Consistent response structure
   - Type-safe response formatting
   - Clear success/error indicators
