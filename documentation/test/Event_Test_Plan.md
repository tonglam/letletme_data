# Event Test Plan

## Overview

This document outlines the test plan for the event functionality in the FPL data system. The tests are organized to ensure proper isolation of concerns while maintaining comprehensive coverage.

## Test Structure

```plaintext
tests/event/
├── route.test.ts                    # API route tests
├── client.test.ts                   # FPL client unit tests
├── domain.test.ts                   # Domain logic tests
├── repository.test.ts               # Repository tests
├── cache.test.ts                    # Cache tests
├── client.integration.test.ts       # FPL API integration tests
├── service.integration.test.ts      # Service integration tests
└── workflow.integration.test.ts     # Workflow integration tests
```

## Unit Tests

### 1. Route Tests (`route.test.ts`)

```typescript
describe('Event Routes', () => {
  describe('GET /events', () => {
    it('should return all events', async () => {
      const response = await request(app).get('/events');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle service errors', async () => {
      // Mock service error
      mockEventService.getEvents.mockRejectedValue(new ServiceError('Service error'));
      const response = await request(app).get('/events');
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('SERVICE_ERROR');
    });
  });

  describe('GET /events/:id', () => {
    it('should validate event ID', async () => {
      const response = await request(app).get('/events/invalid');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should handle not found', async () => {
      mockEventService.getEvent.mockResolvedValue(null);
      const response = await request(app).get('/events/1');
      expect(response.status).toBe(404);
    });
  });
});
```

### 2. Domain Tests (`domain.test.ts`)

```typescript
describe('Event Domain', () => {
  describe('toDomainEvent', () => {
    it('should convert API response to domain model', () => {
      const response = mockEventResponse();
      const event = toDomainEvent(response);
      expect(event.id).toBeDefined();
      expect(event.name).toBe(response.name);
      expect(event.deadlineTime).toBe(response.deadline_time);
    });

    it('should convert Prisma model to domain model', () => {
      const prismaEvent = mockPrismaEvent();
      const event = toDomainEvent(prismaEvent);
      expect(event.id).toBeDefined();
      expect(event.name).toBe(prismaEvent.name);
      expect(event.deadlineTime).toBe(prismaEvent.deadlineTime);
    });
  });

  describe('validateEventId', () => {
    it('should validate valid event ID', () => {
      const result = validateEventId(1);
      expect(E.isRight(result)).toBe(true);
    });

    it('should reject invalid event ID', () => {
      const result = validateEventId('invalid');
      expect(E.isLeft(result)).toBe(true);
    });
  });
});
```

### 3. Repository Tests (`repository.test.ts`)

```typescript
describe('Event Repository', () => {
  beforeEach(async () => {
    await prisma.event.deleteMany();
  });

  describe('findAll', () => {
    it('should return all events', async () => {
      const events = await createTestEvents(3);
      const result = await eventRepository.findAll()();
      expect(result).toHaveLength(3);
      expect(E.isRight(result)).toBe(true);
    });
  });

  describe('findById', () => {
    it('should return event by ID', async () => {
      const event = await createTestEvent();
      const result = await eventRepository.findById(event.id as EventId)();
      expect(E.isRight(result)).toBe(true);
      expect(result._tag).toBe('Right');
    });

    it('should handle not found', async () => {
      const result = await eventRepository.findById(999 as EventId)();
      expect(E.isRight(result)).toBe(true);
      expect(result._tag).toBe('Right');
      expect(result.right).toBeNull();
    });
  });
});
```

### 4. Cache Tests (`cache.test.ts`)

```typescript
describe('Event Cache', () => {
  beforeEach(async () => {
    await redis.flushDb();
  });

  describe('cacheEvent', () => {
    it('should cache single event', async () => {
      const event = mockEvent();
      const result = await eventCache.cacheEvent(event)();
      expect(E.isRight(result)).toBe(true);

      const cached = await eventCache.getEvent(String(event.id))();
      expect(E.isRight(cached)).toBe(true);
      expect(cached.right).toEqual(event);
    });
  });

  describe('getAllEvents', () => {
    it('should return cached events', async () => {
      const events = mockEvents(3);
      await Promise.all(events.map((e) => eventCache.cacheEvent(e)()));
      const result = await eventCache.getAllEvents()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(3);
    });

    it('should handle empty cache', async () => {
      const result = await eventCache.getAllEvents()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(0);
    });
  });
});
```

## Integration Tests

### 1. Service Tests (`service.integration.test.ts`)

```typescript
describe('Event Service Integration', () => {
  beforeEach(async () => {
    await prisma.event.deleteMany();
    await redis.flushDb();
  });

  describe('getEvents', () => {
    it('should return events from cache', async () => {
      const events = await createTestEvents(3);
      await eventService.saveEvents(events)();
      const result = await eventService.getEvents()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(3);
    });

    it('should fetch from repository on cache miss', async () => {
      const events = await createTestEvents(3);
      const result = await eventService.getEvents()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(3);
    });
  });

  describe('syncEventsFromApi', () => {
    it('should sync events from API', async () => {
      const result = await eventService.syncEventsFromApi()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right.length).toBeGreaterThan(0);

      const cached = await eventCache.getAllEvents()();
      expect(E.isRight(cached)).toBe(true);
      expect(cached.right.length).toBeGreaterThan(0);
    });
  });
});
```

### 2. Workflow Tests (`workflow.integration.test.ts`)

```typescript
describe('Event Workflow Integration', () => {
  beforeEach(async () => {
    await prisma.event.deleteMany();
    await redis.flushDb();
  });

  describe('syncEvents', () => {
    it('should execute complete sync workflow', async () => {
      const result = await eventWorkflows.syncEvents()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right.context.workflowId).toBeDefined();
      expect(result.right.duration).toBeGreaterThan(0);
      expect(result.right.result.length).toBeGreaterThan(0);
    });

    it('should handle API errors', async () => {
      mockBootstrapApi.getBootstrapEvents.mockRejectedValue(new Error('API error'));
      const result = await eventWorkflows.syncEvents()();
      expect(E.isLeft(result)).toBe(true);
      expect(result.left.code).toBe('INTEGRATION_ERROR');
    });
  });
});
```

## Test Environment Setup

### 1. Dependencies

```typescript
// test/setup.ts
import { PrismaClient } from '@prisma/client';
import { createRedisClient } from '../src/infrastructure/cache/redis';

export const prisma = new PrismaClient();
export const redis = createRedisClient();

beforeAll(async () => {
  await prisma.$connect();
  await redis.connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});
```

### 2. Test Utilities

```typescript
// test/utils/event.test.utils.ts
export const mockEvent = (overrides?: Partial<Event>): Event => ({
  id: 1 as EventId,
  name: 'Gameweek 1',
  deadlineTime: '2023-08-11T17:30:00Z',
  // ... other fields
  ...overrides,
});

export const mockEvents = (count: number): Event[] =>
  Array.from({ length: count }, (_, i) => mockEvent({ id: (i + 1) as EventId }));

export const createTestEvent = async (overrides?: Partial<Event>): Promise<Event> => {
  const event = mockEvent(overrides);
  await prisma.event.create({ data: toPrismaEvent(event) });
  return event;
};
```

## Running Tests

```bash
# Run all event tests
npm test tests/event

# Run specific test suites
npm test tests/event/route.test.ts
npm test tests/event/domain.test.ts
npm test tests/event/repository.test.ts
npm test tests/event/cache.test.ts

# Run integration tests
npm test tests/event/service.integration.test.ts
npm test tests/event/workflow.integration.test.ts

# Run with coverage
npm test -- --coverage tests/event
```

## Best Practices

1. **Test Isolation**

   - Clean database before each test
   - Reset cache between tests
   - Mock external dependencies
   - Use test utilities

2. **Type Safety**

   - Test type guards
   - Validate conversions
   - Check error types
   - Verify TaskEither results

3. **Error Handling**

   - Test error scenarios
   - Verify error codes
   - Check error messages
   - Test error propagation

4. **Performance**
   - Monitor test execution time
   - Test cache effectiveness
   - Verify batch operations
   - Test concurrent access
