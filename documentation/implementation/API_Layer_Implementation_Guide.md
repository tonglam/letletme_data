# API Layer Implementation Guide

## Table of Contents

- [API Layer Implementation Guide](#api-layer-implementation-guide)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Directory Structure](#directory-structure)
  - [Core Components](#core-components)
    - [Types](#types)
    - [Response Formatting](#response-formatting)
    - [Middleware](#middleware)
    - [Routes](#routes)
  - [Route Implementation Guide](#route-implementation-guide)
    - [Basic Structure](#basic-structure)
    - [Handler Implementation](#handler-implementation)
    - [Error Handling](#error-handling)
    - [Logging](#logging)
  - [Best Practices](#best-practices)
  - [Security Considerations](#security-considerations)
  - [Validation](#validation)
  - [Examples](#examples)

## Introduction

This guide outlines the standard practices and patterns for implementing API routes in the application. It follows functional programming principles, emphasizes type safety, and maintains consistent error handling and response formatting.

## Directory Structure

```
src/api/
├── middleware/     # API middleware components
├── responses/      # Response formatting utilities
├── routes/         # API route handlers
└── types.ts        # API-specific type definitions
```

## Core Components

### Types

All API-related types should be defined in `src/api/types.ts`. Key types include:

```typescript
// Success response wrapper
interface APIResponse<T> {
  readonly status: 'success';
  readonly data: T;
}

// Error response structure
interface ErrorResponse {
  readonly status: 'error';
  readonly error: string;
  readonly details?: unknown;
}

// Extended Express Request
type ApiRequest = Request & { id: string };
```

### Response Formatting

Consistent response formatting using utility functions from `src/api/responses`:

```typescript
// Success response
formatResponse<T>(data: T): APIResponse<T>

// Error response
formatErrorResponse(error: Error | string): ErrorResponse
```

### Middleware

Standard middleware components:

1. **Error Handling**: Global error middleware for consistent error responses
2. **Security**:
   - Helmet for HTTP headers
   - CORS configuration
   - Rate limiting
3. **Validation**: Request validation using Zod schemas

### Routes

Routes should follow a modular structure with clear separation of concerns:

1. Router configuration
2. Handler implementations
3. Route registration

## Route Implementation Guide

### Basic Structure

Follow this template for new route files:

```typescript
/**
 * Domain-specific API routes module
 * @module api/routes/domain
 */

import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const domainRouter = ({ domainService }: ServiceContainer): Router => {
  const router = Router();

  // Handler implementations

  // Route registration

  return router;
};
```

### Handler Implementation

1. **Function Signature**:

```typescript
const handlerName: RequestHandler = async (req, res) => {
  // Implementation
};
```

2. **Functional Approach**:

- Use `fp-ts` for error handling and composition
- Implement with `pipe` and `Either` for type-safe error handling

Example:

```typescript
const getResource: RequestHandler = async (req, res) => {
  logApiRequest(req as ApiRequest, 'Get resource');

  pipe(
    await service.getResource()(),
    E.fold(
      (error) => {
        logApiError(req as ApiRequest, error as Error);
        res.status(500).json(formatErrorResponse(error as Error));
      },
      (resource) => res.json(formatResponse(resource)),
    ),
  );
};
```

### Error Handling

1. Use `Either` for error handling
2. Log errors with context
3. Return formatted error responses
4. Maintain consistent HTTP status codes

### Logging

Always include request logging:

1. Log requests with context
2. Log errors with full details
3. Include request ID for tracing

## Best Practices

1. **Type Safety**:

   - Avoid `any` type
   - Use proper type definitions
   - Leverage TypeScript's type system

2. **Functional Programming**:

   - Use immutable data structures
   - Implement pure functions
   - Leverage `fp-ts` for functional patterns

3. **Code Organization**:

   - One route file per domain
   - Clear function naming
   - Proper JSDoc documentation

4. **Error Handling**:
   - Consistent error formatting
   - Proper error logging
   - Type-safe error handling with `Either`

## Security Considerations

1. **Request Validation**:

   - Validate all inputs
   - Use Zod schemas
   - Implement proper type checking

2. **Security Headers**:

   - Use Helmet middleware
   - Configure CORS properly
   - Implement rate limiting

3. **Error Responses**:
   - Don't expose internal errors
   - Sanitize error messages
   - Use appropriate status codes

## Validation

Implement request validation using Zod schemas:

```typescript
const validateRequest = (schema: AnyZodObject) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Validation implementation
  };
};
```

## Examples

Reference implementation from `events.route.ts`:

```typescript
// Route handler example
const getEventById: RequestHandler = async (req, res) => {
  const eventId = Number(req.params.id) as EventId;
  logApiRequest(req as ApiRequest, 'Get event by ID', { eventId });

  pipe(
    await eventService.getEvent(eventId)(),
    E.fold(
      (error) => {
        logApiError(req as ApiRequest, error as Error);
        res.status(500).json(formatErrorResponse(error as Error));
      },
      (event) => res.json(formatResponse(event)),
    ),
  );
};

// Route registration
router.get('/events/:id', getEventById);
```

This example demonstrates:

- Proper type safety
- Functional error handling
- Request logging
- Response formatting
- Clean route registration
