# Event Test Plan

This document outlines the test plan for the event functionality in the FPL data system. The tests are organized to ensure proper isolation of concerns while maintaining comprehensive coverage.

> **Important**: This test suite uses actual dependencies (FPL API, Prisma DB, Redis) instead of mocks to ensure real-world behavior testing. Each test is responsible for cleaning up only the data it creates.

## 1. Unit Tests

### 1.1 FPL Client Tests (`tests/event/client.test.ts`)

Test FPL API client in isolation:

- [x] Bootstrap API Integration
  - [x] Successful response with valid data structure
  - [x] Events array validation
  - [x] Rate limit handling
  - [x] Timeout scenarios
  - [x] Network error recovery
  - [x] Retry mechanism verification

### 1.2 Domain Tests (`tests/event/domain.test.ts`)

Test domain logic and data transformations in isolation:

- [x] Event Domain Operations

  - [x] Event data transformation (API → Domain)
  - [x] Event state transitions
  - [x] Event validation rules
  - [x] Business logic constraints
  - [x] Edge cases handling

- [x] Event Aggregates

  - [x] Event relationships
  - [x] Event lifecycle rules
  - [x] Domain event handling
  - [x] Invariant validations

- [ ] Value Objects
  - [ ] Event status transitions
  - [ ] Event date calculations
  - [ ] Event scoring rules
  - [ ] Immutability checks

### 1.3 Repository Tests (`tests/event/repository.test.ts`)

Test database operations in isolation:

- [x] Event Repository Operations
  - [x] Find all events with pagination
  - [x] Find event by ID
  - [x] Find current/next event
  - [x] Create/Update/Delete operations
  - [x] Constraint validations
  - [x] Transaction handling

### 1.4 Cache Tests (`tests/event/cache.test.ts`)

Test caching operations in isolation:

- [ ] Redis Operations
  - [ ] Set/Get operations with TTL
  - [ ] Cache hit/miss scenarios
  - [ ] Key pattern validation
  - [ ] Lock mechanism
  - [ ] Cache invalidation
  - [ ] Error handling

## 2. Integration Tests

### 2.1 Service Integration (`tests/event/service.integration.test.ts`)

Test service layer that coordinates between cache, database, and API:

- [x] Service Operations
  - [x] Data flow between cache and database
  - [x] API fallback on cache miss
  - [x] Data consistency verification
  - [x] Error propagation
  - [x] Resource cleanup
  - [x] Transaction management

### 2.2 Workflow Integration (`tests/event/workflow.integration.test.ts`)

Test complete event workflow including all components:

- [ ] End-to-End Flow
  - [ ] Complete data pipeline (API → Queue → Cache → DB)
  - [ ] System state consistency
  - [ ] Error recovery
  - [ ] Resource management
  - [ ] Performance verification

## 3. Test Environment Setup

### 3.1 Prerequisites

- Configuration via `.env` file in project root
- Access to production infrastructure:
  - Supabase PostgreSQL database
  - Redis instance
  - FPL API (rate limited)
- No separate test environment required as we use the same infrastructure

### 3.2 Test Data Management

```typescript
// Example cleanup pattern
beforeEach(async () => {
  testKeys = [];
  testIds = [];
  testJobs = [];
});

afterEach(async () => {
  // IMPORTANT: Ensure cleanup only removes test data
  await Promise.all([
    ...testKeys.map((key) => redis.del(key)),
    ...testIds.map((id) => prisma.event.delete({ where: { id } })),
    ...testJobs.map((job) => queue.remove(job)),
  ]);
});

// Utility to prefix test keys for isolation
const getTestKey = (key: string) => `test:${key}`;
```

### 3.3 Test Data Samples

#### Bootstrap Data (`tests/data/bootstrap.json`)

- Sample response data from FPL Bootstrap API endpoint
- Used for client integration tests and domain transformation tests
- Contains complete event data structure for validation
- Serves as a snapshot of real API response
- Used to verify:
  - Data structure compliance
  - Field type validation
  - Required property presence
  - Edge cases in data transformation
  - Domain model mapping accuracy

> **Note**: The bootstrap.json file is maintained as a static test fixture to ensure consistent test behavior and avoid API rate limiting during development.

## 4. Test Execution

```bash
# All configuration is loaded from .env file
# No additional environment setup needed

# Run specific test suites
npm test tests/event/client.test.ts
npm test tests/event/domain.test.ts
npm test tests/event/repository.test.ts
npm test tests/event/cache.test.ts
npm test tests/event/queue.test.ts
npm test tests/event/service.integration.test.ts
npm test tests/event/workflow.integration.test.ts

# Run all event tests
npm test tests/event
```

> **Important Notes**:
>
> 1. All tests use the same infrastructure as production
> 2. Tests must be carefully designed to not interfere with production data
> 3. Use prefixes for test data (keys, IDs) to ensure isolation
> 4. Always clean up test data after each test
> 5. Be mindful of API rate limits when testing
