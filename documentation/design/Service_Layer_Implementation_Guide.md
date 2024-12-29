# Service Layer Implementation Guide

## Overview

The service layer acts as an orchestrator between the API layer and domain layer, implementing business use cases while maintaining functional programming principles using fp-ts. This guide demonstrates the implementation patterns using the Events service as a reference.

## File Structure

A service module should follow this structure:

```plaintext
src/services/{service-name}/
├── index.ts     # Public API exports
├── types.ts     # Service interfaces and types
├── service.ts   # Main service implementation
├── cache.ts     # Service-level cache implementation
└── workflow.ts  # Complex business workflows
```

## Service Types

Define service interfaces in `types.ts`:

```typescript
// Service interface
export interface EventService {
  readonly getEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly saveEvents: (events: readonly Event[]) => TE.TaskEither<ServiceError, readonly Event[]>;
}

// Service dependencies
export interface EventServiceDependencies {
  readonly bootstrapApi: BootstrapApi;
  readonly eventCache: EventCache;
  readonly eventRepository: EventRepository;
}
```

## Service Implementation

Implement the service in `service.ts` following these patterns:

1. **Pure Functions**: Each operation should be implemented as a pure function
2. **Error Handling**: Use TaskEither for consistent error handling
3. **Dependency Injection**: Accept dependencies through factory function
4. **Composition**: Use fp-ts pipe and flow for function composition

Example:

```typescript
const findAllEvents = (
  repository: EventRepositoryOperations,
  cache: EventCache,
): TE.TaskEither<ServiceError, readonly Event[]> =>
  pipe(
    cache.getAllEvents(),
    TE.mapLeft((error) =>
      createServiceIntegrationError({
        message: 'Failed to fetch events from cache',
        cause: error,
      }),
    ),
    TE.chain((cached) =>
      cached.length > 0
        ? TE.right(cached)
        : pipe(
            repository.findAll(),
            TE.mapLeft((error) =>
              createServiceOperationError({
                message: 'Failed to fetch events from repository',
                cause: error,
              }),
            ),
          ),
    ),
  );

export const createEventService = (
  bootstrapApi: BootstrapApi,
  repository: EventRepositoryOperations,
): EventService => {
  const cache = createEventServiceCache(bootstrapApi);

  return {
    getEvents: () => findAllEvents(repository, cache),
    // ... other operations
  };
};
```

## Cache Integration

Implement service-level caching in `cache.ts`:

1. **Cache Factory**: Create a cache instance with proper configuration
2. **Data Provider**: Implement data provider for cache misses
3. **Error Handling**: Handle cache errors gracefully
4. **TTL Management**: Configure appropriate TTLs for different data types

Example:

```typescript
export const createEventServiceCache = (bootstrapApi: BootstrapApi): EventCache => {
  const redis = createRedisCache<Event>({
    keyPrefix: CachePrefix.EVENT,
    defaultTTL: DefaultTTL.EVENT,
  });

  const config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  };

  const dataProvider = createEventDataProvider(bootstrapApi);

  return createEventCache(redis, dataProvider, config);
};
```

## Error Handling

Follow these error handling patterns:

1. **Error Types**:

   - ServiceOperationError: For business logic errors
   - ServiceIntegrationError: For external service errors

2. **Error Creation**:

```typescript
TE.mapLeft((error) =>
  createServiceIntegrationError({
    message: 'Failed to fetch from cache',
    cause: error,
  }),
);
```

3. **Error Flow**:
   - Catch errors at boundaries
   - Transform domain errors to service errors
   - Provide meaningful error messages

## Best Practices

1. **Type Safety**:

   - Use strict TypeScript configuration
   - Avoid type assertions
   - Define precise interfaces
   - Use branded types for IDs

2. **Functional Programming**:

   - Use fp-ts for functional operations
   - Maintain immutability
   - Compose functions with pipe
   - Handle effects with TaskEither

3. **Testing**:

   - Unit test pure functions
   - Mock external dependencies
   - Test error scenarios
   - Verify type safety

4. **Performance**:
   - Implement proper caching
   - Use connection pooling
   - Batch operations when possible
   - Monitor performance metrics

## Common Patterns

1. **Factory Pattern**:

```typescript
export const createService = (deps: Dependencies): Service => {
  // Initialize resources
  return {
    // Implement operations
  };
};
```

2. **Cache-Repository Pattern**:

```typescript
const findData = (cache: Cache, repository: Repository) =>
  pipe(
    cache.get(),
    TE.chain((cached) => (cached ? TE.right(cached) : repository.find())),
  );
```

3. **Error Transformation**:

```typescript
TE.mapLeft((error) =>
  createServiceError({
    message: 'Operation failed',
    cause: error,
  }),
);
```

## Monitoring and Observability

1. **Metrics to Track**:

   - Operation latency
   - Cache hit rates
   - Error rates
   - Resource usage

2. **Logging**:
   - Operation start/end
   - Error details
   - Performance metrics
   - Business events

## Implementation Checklist

1. **Setup**:

   - [ ] Create service directory structure
   - [ ] Define service types
   - [ ] Configure dependencies

2. **Implementation**:

   - [ ] Implement service operations
   - [ ] Set up caching
   - [ ] Handle errors
   - [ ] Add logging

3. **Testing**:

   - [ ] Write unit tests
   - [ ] Test error scenarios
   - [ ] Verify type safety
   - [ ] Measure performance

4. **Documentation**:
   - [ ] Document public API
   - [ ] Explain error handling
   - [ ] Describe caching strategy
   - [ ] List dependencies

```

```
