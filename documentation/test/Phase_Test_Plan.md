# Phase Test Plan

## Overview

This document outlines the test plan for the phase functionality in the FPL data system. The tests are organized to ensure proper isolation of concerns while maintaining comprehensive coverage.

## Test Structure

```plaintext
tests/phase/
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
describe('Phase Routes', () => {
  describe('GET /phases', () => {
    it('should return all phases', async () => {
      const response = await request(app).get('/phases');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle service errors', async () => {
      // Mock service error
      mockPhaseService.getPhases.mockRejectedValue(new ServiceError('Service error'));
      const response = await request(app).get('/phases');
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('SERVICE_ERROR');
    });
  });

  describe('GET /phases/:id', () => {
    it('should validate phase ID', async () => {
      const response = await request(app).get('/phases/invalid');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should handle not found', async () => {
      mockPhaseService.getPhase.mockResolvedValue(null);
      const response = await request(app).get('/phases/1');
      expect(response.status).toBe(404);
    });
  });
});
```

### 2. Domain Tests (`domain.test.ts`)

```typescript
describe('Phase Domain', () => {
  describe('toDomainPhase', () => {
    it('should convert API response to domain model', () => {
      const response = mockPhaseResponse();
      const phase = toDomainPhase(response);
      expect(phase.id).toBeDefined();
      expect(phase.name).toBe(response.name);
      expect(phase.startTime).toBe(response.start_time);
      expect(phase.endTime).toBe(response.end_time);
    });

    it('should convert Prisma model to domain model', () => {
      const prismaPhase = mockPrismaPhase();
      const phase = toDomainPhase(prismaPhase);
      expect(phase.id).toBeDefined();
      expect(phase.name).toBe(prismaPhase.name);
      expect(phase.startTime).toBe(prismaPhase.startTime);
      expect(phase.endTime).toBe(prismaPhase.endTime);
    });
  });

  describe('validatePhaseId', () => {
    it('should validate valid phase ID', () => {
      const result = validatePhaseId(1);
      expect(E.isRight(result)).toBe(true);
    });

    it('should reject invalid phase ID', () => {
      const result = validatePhaseId('invalid');
      expect(E.isLeft(result)).toBe(true);
    });
  });
});
```

### 3. Repository Tests (`repository.test.ts`)

```typescript
describe('Phase Repository', () => {
  beforeEach(async () => {
    await prisma.phase.deleteMany();
  });

  describe('findAll', () => {
    it('should return all phases', async () => {
      const phases = await createTestPhases(3);
      const result = await phaseRepository.findAll()();
      expect(result).toHaveLength(3);
      expect(E.isRight(result)).toBe(true);
    });
  });

  describe('findById', () => {
    it('should return phase by ID', async () => {
      const phase = await createTestPhase();
      const result = await phaseRepository.findById(phase.id as PhaseId)();
      expect(E.isRight(result)).toBe(true);
      expect(result._tag).toBe('Right');
    });

    it('should handle not found', async () => {
      const result = await phaseRepository.findById(999 as PhaseId)();
      expect(E.isRight(result)).toBe(true);
      expect(result._tag).toBe('Right');
      expect(result.right).toBeNull();
    });
  });
});
```

### 4. Cache Tests (`cache.test.ts`)

```typescript
describe('Phase Cache', () => {
  beforeEach(async () => {
    await redis.flushDb();
  });

  describe('cachePhase', () => {
    it('should cache single phase', async () => {
      const phase = mockPhase();
      const result = await phaseCache.cachePhase(phase)();
      expect(E.isRight(result)).toBe(true);

      const cached = await phaseCache.getPhase(String(phase.id))();
      expect(E.isRight(cached)).toBe(true);
      expect(cached.right).toEqual(phase);
    });
  });

  describe('getAllPhases', () => {
    it('should return cached phases', async () => {
      const phases = mockPhases(3);
      await Promise.all(phases.map((p) => phaseCache.cachePhase(p)()));
      const result = await phaseCache.getAllPhases()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(3);
    });

    it('should handle empty cache', async () => {
      const result = await phaseCache.getAllPhases()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(0);
    });
  });
});
```

## Integration Tests

### 1. Service Tests (`service.integration.test.ts`)

```typescript
describe('Phase Service Integration', () => {
  beforeEach(async () => {
    await prisma.phase.deleteMany();
    await redis.flushDb();
  });

  describe('getPhases', () => {
    it('should return phases from cache', async () => {
      const phases = await createTestPhases(3);
      await phaseService.savePhases(phases)();
      const result = await phaseService.getPhases()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(3);
    });

    it('should fetch from repository on cache miss', async () => {
      const phases = await createTestPhases(3);
      const result = await phaseService.getPhases()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right).toHaveLength(3);
    });
  });

  describe('syncPhasesFromApi', () => {
    it('should sync phases from API', async () => {
      const result = await phaseService.syncPhasesFromApi()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right.length).toBeGreaterThan(0);

      const cached = await phaseCache.getAllPhases()();
      expect(E.isRight(cached)).toBe(true);
      expect(cached.right.length).toBeGreaterThan(0);
    });
  });
});
```

### 2. Workflow Tests (`workflow.integration.test.ts`)

```typescript
describe('Phase Workflow Integration', () => {
  beforeEach(async () => {
    await prisma.phase.deleteMany();
    await redis.flushDb();
  });

  describe('syncPhases', () => {
    it('should execute complete sync workflow', async () => {
      const result = await phaseWorkflows.syncPhases()();
      expect(E.isRight(result)).toBe(true);
      expect(result.right.context.workflowId).toBeDefined();
      expect(result.right.duration).toBeGreaterThan(0);
      expect(result.right.result.length).toBeGreaterThan(0);
    });

    it('should handle API errors', async () => {
      mockBootstrapApi.getBootstrapPhases.mockRejectedValue(new Error('API error'));
      const result = await phaseWorkflows.syncPhases()();
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
// test/utils/phase.test.utils.ts
export const mockPhase = (overrides?: Partial<Phase>): Phase => ({
  id: 1 as PhaseId,
  name: 'Overall',
  startTime: '2023-08-11T17:30:00Z',
  endTime: '2024-05-19T15:00:00Z',
  // ... other fields
  ...overrides,
});

export const mockPhases = (count: number): Phase[] =>
  Array.from({ length: count }, (_, i) => mockPhase({ id: (i + 1) as PhaseId }));

export const createTestPhase = async (overrides?: Partial<Phase>): Promise<Phase> => {
  const phase = mockPhase(overrides);
  await prisma.phase.create({ data: toPrismaPhase(phase) });
  return phase;
};
```

## Running Tests

```bash
# Run all phase tests
npm test tests/phase

# Run specific test suites
npm test tests/phase/route.test.ts
npm test tests/phase/domain.test.ts
npm test tests/phase/repository.test.ts
npm test tests/phase/cache.test.ts

# Run integration tests
npm test tests/phase/service.integration.test.ts
npm test tests/phase/workflow.integration.test.ts

# Run with coverage
npm test -- --coverage tests/phase
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
