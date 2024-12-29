# API Layer Implementation Guide

## Table of Contents

- [API Layer Implementation Guide](#api-layer-implementation-guide)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Directory Structure](#directory-structure)
  - [Core Components](#core-components)
  - [Implementation Steps](#implementation-steps)
  - [Type Definitions](#type-definitions)
  - [Handler Implementation](#handler-implementation)
  - [Route Implementation](#route-implementation)
  - [Best Practices](#best-practices)
  - [Example Implementation](#example-implementation)

## Introduction

This guide provides detailed instructions for implementing new API endpoints following the functional programming approach with fp-ts. It ensures type safety, consistent error handling, and maintainable code structure.

## Directory Structure

For each new domain API, you need to create the following structure:

```
src/api/
├── handlers/
│   └── {domain}.handler.ts    # Domain-specific handlers
├── middleware/
│   ├── core.ts                # Core middleware functions
│   └── index.ts               # Middleware exports
├── routes/
│   └── {domain}.route.ts      # Domain-specific routes
├── types.ts                   # API-specific type definitions
├── utils.ts                   # API utility functions
└── index.ts                   # API router configuration
```

## Core Components

1. **Types Module (`types.ts`)**

   - Defines API-specific types and interfaces
   - Implements validation codecs
   - Declares handler interfaces

2. **Utils Module (`utils.ts`)**

   - Provides utility functions for API operations
   - Implements error handling and response formatting
   - Contains functional programming helpers

3. **Handler Module (`handlers/{domain}.handler.ts`)**

   - Contains business logic for API endpoints
   - Uses fp-ts for functional error handling
   - Implements domain-specific operations

4. **Route Module (`routes/{domain}.route.ts`)**
   - Defines API endpoints
   - Configures route middleware
   - Maps handlers to routes

## Implementation Steps

1. Define API-specific types in `src/api/types.ts`
2. Create handler implementation in `handlers/{domain}.handler.ts`
3. Create route configuration in `routes/{domain}.route.ts`
4. Register routes in `src/api/index.ts`

## Type Definitions

Add your domain-specific types to `src/api/types.ts`:

```typescript
// Request validation codec
export const DomainIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

// Handler response interface
export interface DomainHandlerResponse {
  readonly getAllItems: () => TaskEither<APIError, Item[]>;
  readonly getItemById: (req: Request) => TaskEither<APIError, Item>;
  // Add other operations
}
```

## Handler Implementation

Create `handlers/{domain}.handler.ts`:

```typescript
export const createDomainHandlers = (
  domainService: ServiceContainer[typeof ServiceKey.DOMAIN],
): DomainHandlerResponse => ({
  getAllItems: () => {
    const task = domainService.getItems();
    return pipe(
      () => task(),
      TE.map((items) => [...items]),
    );
  },

  getItemById: (req: Request) => {
    const itemId = Number(req.params.id) as ItemId;
    return pipe(
      () => domainService.getItem(itemId)(),
      TE.chain((item) => () => Promise.resolve(handleNullable<Item>(`Item not found`)(item))),
    );
  },
});
```

## Route Implementation

Create `routes/{domain}.route.ts`:

```typescript
export const domainRouter = ({ domainService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createDomainHandlers(domainService);

  router.get('/', createHandler(handlers.getAllItems));
  router.get('/:id', validateRequest(DomainIdParams), createHandler(handlers.getItemById));

  return router;
};
```

## Best Practices

1. **Type Safety**

   - Use io-ts for runtime type validation
   - Define explicit return types
   - Avoid type `any`

2. **Error Handling**

   - Use TaskEither for async operations
   - Implement consistent error responses
   - Handle null cases with `handleNullable`

3. **Code Organization**

   - Keep API-specific types in `types.ts`
   - Place common utilities in `utils.ts`
   - One handler file per domain
   - One route file per domain

4. **Functional Programming**
   - Use fp-ts operators (pipe, chain, map)
   - Implement pure functions
   - Handle side effects in TaskEither

## Example Implementation

Here's a complete example using the Events API implementation:

### Handler (`handlers/events.handler.ts`):

```typescript
export const createEventHandlers = (
  eventService: ServiceContainer[typeof ServiceKey.EVENT],
): EventHandlerResponse => ({
  getAllEvents: () => {
    const task = eventService.getEvents();
    return pipe(
      () => task(),
      TE.map((events) => [...events]),
    );
  },

  getEventById: (req: Request) => {
    const eventId = Number(req.params.id) as EventId;
    return pipe(
      () => eventService.getEvent(eventId)(),
      TE.chain((event) => () => Promise.resolve(handleNullable<Event>(`Event not found`)(event))),
    );
  },
});
```

### Route (`routes/events.route.ts`):

```typescript
export const eventRouter = ({ eventService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  router.get('/', createHandler(handlers.getAllEvents));
  router.get('/:id', validateRequest(EventIdParams), createHandler(handlers.getEventById));

  return router;
};
```

This implementation demonstrates:

- Proper type safety
- Functional error handling
- Clean separation of concerns
- Consistent response formatting
- Middleware integration
