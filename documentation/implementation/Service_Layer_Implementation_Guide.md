# Service Layer Implementation Guide

## Overview

This guide demonstrates how to implement a service layer following functional programming principles using fp-ts. The guide uses the Events service as a reference implementation.

## Directory Structure

A service module should follow this structure:

```plaintext
src/service/
├── index.ts                 # Service container and exports
├── utils.ts                 # Shared service utilities
└── {service-name}/         # Service module directory
    ├── index.ts            # Service module exports
    ├── service.ts          # Core service implementation
    ├── types.ts            # Service interfaces and types
    └── workflow.ts         # Complex business workflows
```

## Service Types

Define service interfaces in `types.ts`:

```typescript
// Public service interface
export interface EventService {
  readonly getEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly saveEvents: (events: readonly Event[]) => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, readonly Event[]>;
}

// Service dependencies
export interface EventServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
}

// Internal service operations
export interface EventServiceOperations {
  readonly findAllEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly findEventById: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly findCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly findNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly syncEventsFromApi: (
    bootstrapApi: EventServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, readonly Event[]>;
}
```

## Service Implementation

Implement the service in `service.ts`:

```typescript
// Maps domain errors to service errors
const mapDomainError = (error: DomainError): ServiceError =>
  createServiceOperationError({
    message: error.message,
    cause: error,
  });

// Implementation of service operations
const eventServiceOperations = (domainOps: EventOperations): EventServiceOperations => ({
  findAllEvents: () => pipe(domainOps.getAllEvents(), TE.mapLeft(mapDomainError)),
  findEventById: (id: EventId) => pipe(domainOps.getEventById(id), TE.mapLeft(mapDomainError)),
  findCurrentEvent: () => pipe(domainOps.getCurrentEvent(), TE.mapLeft(mapDomainError)),
  findNextEvent: () => pipe(domainOps.getNextEvent(), TE.mapLeft(mapDomainError)),
  syncEventsFromApi: (bootstrapApi: EventServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapEvents(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch events from API',
          cause: error,
        }),
      ),
      TE.map((events: readonly EventResponse[]) => events.map(toDomainEvent)),
      TE.chain((events) =>
        pipe(
          domainOps.deleteAll(),
          TE.mapLeft(mapDomainError),
          TE.chain(() => pipe(domainOps.createEvents(events), TE.mapLeft(mapDomainError))),
        ),
      ),
    ),
});

export const createEventService = (
  bootstrapApi: EventServiceDependencies['bootstrapApi'],
  repository: EventRepositoryOperations,
): EventService => {
  const domainOps = createEventOperations(repository);
  const ops = eventServiceOperations(domainOps);

  return {
    getEvents: () => ops.findAllEvents(),
    getEvent: (id: EventId) => ops.findEventById(id),
    getCurrentEvent: () => ops.findCurrentEvent(),
    getNextEvent: () => ops.findNextEvent(),
    saveEvents: (events: readonly Event[]) =>
      pipe(domainOps.createEvents(events), TE.mapLeft(mapDomainError)),
    syncEventsFromApi: () => ops.syncEventsFromApi(bootstrapApi),
  };
};
```

## Workflow Implementation

Complex business workflows should be implemented in `workflow.ts`:

```typescript
export const createEventWorkflow = (eventService: EventService) => {
  const syncEvents = () =>
    pipe(
      eventService.syncEventsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
    );

  return {
    syncEvents,
  } as const;
};
```

## Best Practices

1. **Type Safety**

   - Use TaskEither for all operations
   - Define explicit service interfaces
   - Map domain types to service types
   - Handle all error cases

2. **Error Handling**

   - Map domain errors to service errors
   - Provide detailed error messages
   - Include error causes
   - Use appropriate error types

3. **Functional Programming**

   - Use pipe for composition
   - Keep functions pure
   - Use readonly types
   - Avoid side effects

4. **Testing**
   - Unit test service operations
   - Integration test workflows
   - Mock external dependencies
   - Test error scenarios

## Common Patterns

1. **Service Factory Pattern**

```typescript
export const createService = (deps: Dependencies): Service => {
  const domainOps = createDomainOperations(deps.repository);
  const ops = serviceOperations(domainOps);
  return createServiceInterface(ops);
};
```

2. **Error Mapping Pattern**

```typescript
const mapError = (error: DomainError): ServiceError =>
  createServiceError({
    code: mapErrorCode(error.code),
    message: error.message,
    cause: error,
  });
```

3. **Operation Composition Pattern**

```typescript
const operation = () =>
  pipe(
    domainOperation(),
    TE.mapLeft(mapDomainError),
    TE.chain((result) => nextOperation(result)),
  );
```

## Implementation Steps

1. Create service directory structure
2. Define service types and interfaces
3. Implement core service operations
4. Add error handling
5. Implement complex workflows
6. Add tests
