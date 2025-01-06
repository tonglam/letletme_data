# Service Layer Implementation Guide

## Overview

This guide demonstrates how to implement a service layer following functional programming principles using fp-ts. The guide uses the Events service as a reference implementation.

## File Structure

A service module should follow this structure:

```plaintext
src/service/{service-name}/
├── index.ts     # Public API exports
├── types.ts     # Service interfaces and types
├── service.ts   # Main service implementation
├── operations.ts # Service operations
└── workflow.ts  # Complex business workflows
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

// Service with workflow capabilities
export interface EventServiceWithWorkflows extends EventService {
  readonly workflows: {
    readonly syncEvents: () => TE.TaskEither<ServiceError, WorkflowResult<readonly Event[]>>;
  };
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

// Workflow types
export interface WorkflowContext {
  readonly workflowId: string;
  readonly startTime: Date;
}

export interface WorkflowResult<T> {
  readonly context: WorkflowContext;
  readonly result: T;
  readonly duration: number;
}
```

## Service Implementation

Implement the service in `service.ts`:

```typescript
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

## Service Operations

Implement operations in `operations.ts`:

```typescript
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
```

## Workflow Implementation

Implement workflows in `workflow.ts`:

```typescript
export const eventWorkflows = (eventService: EventService) => {
  const syncEvents = (): TE.TaskEither<ServiceError, WorkflowResult<readonly Event[]>> => {
    const context = createWorkflowContext('event-sync');

    logger.info({ workflow: context.workflowId }, 'Starting event sync workflow');

    return pipe(
      eventService.syncEventsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((events) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            count: events.length,
            durationMs: duration,
          },
          'Event sync workflow completed successfully',
        );

        return {
          context,
          result: events,
          duration,
        };
      }),
    );
  };

  return {
    syncEvents,
  } as const;
};
```

## Error Handling

```typescript
// Map domain errors to service errors
const mapDomainError = (error: DomainError): ServiceError =>
  createServiceOperationError({
    message: error.message,
    cause: error,
  });

// Create service integration error
const createServiceIntegrationError = (params: {
  message: string;
  cause?: unknown;
}): ServiceError => ({
  code: ServiceErrorCode.INTEGRATION_ERROR,
  message: params.message,
  cause: params.cause,
});
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
   - Log errors appropriately

3. **Workflow Management**

   - Create workflow context
   - Track workflow duration
   - Log workflow progress
   - Handle workflow errors

4. **Testing**

   - Unit test service operations
   - Integration test workflows
   - Mock external dependencies
   - Test error scenarios

5. **Performance**
   - Track operation metrics
   - Monitor workflow duration
   - Log performance data
   - Handle timeouts

## Implementation Steps

1. Define service types and interfaces
2. Create service operations
3. Implement workflows
4. Add error handling
5. Set up logging
6. Add tests

## Common Patterns

1. **Service Factory Pattern**

```typescript
export const createService = (deps: Dependencies): Service => {
  const domainOps = createDomainOperations(deps.repository);
  const ops = createServiceOperations(domainOps);
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

3. **Workflow Pattern**

```typescript
const executeWorkflow = <T>(
  workflowId: string,
  operation: () => TE.TaskEither<ServiceError, T>,
) => {
  const context = createWorkflowContext(workflowId);
  return pipe(
    operation(),
    TE.map((result) => ({
      context,
      result,
      duration: new Date().getTime() - context.startTime.getTime(),
    })),
  );
};
```
