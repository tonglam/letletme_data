# Event Test Plan

This document outlines the test plan for the event functionality in the FPL data system. The tests are organized to ensure proper isolation of concerns while maintaining comprehensive coverage.

> **Important**: This test suite uses actual dependencies (FPL API, Prisma DB, Redis) instead of mocks to ensure real-world behavior testing. Each test is responsible for cleaning up only the data it creates.

## 1. Unit Tests

### 1.1 FPL Client Tests (`tests/event/client.test.ts`)

Test FPL API client functionality with real API:

- [x] Bootstrap API Integration
  - [x] Successful data fetching
  - [x] Basic structure validation (arrays exist)
  - [x] Required field presence
  - [x] Rate limit handling
  - [x] Error recovery
  - [x] Timeout handling

### 1.2 Adapter Tests (`tests/event/adapter.test.ts`)

Test data transformation and validation:

- [x] Bootstrap Adapter
  - [x] Data transformation (API → Domain)
  - [x] Field mapping
  - [x] Flexible validation
  - [x] Error handling
  - [x] Edge cases (null, undefined, empty arrays)

### 1.3 Domain Tests (`tests/event/domain.test.ts`)

Test domain logic and business rules:

- [x] Event Domain Model

  - [x] Event state management
  - [x] Business rules
  - [x] Validation rules
  - [x] Edge cases

- [x] Event Operations
  - [x] Event lifecycle
  - [x] State transitions
  - [x] Invariant checks

### 1.4 Repository Tests (`tests/event/repository.test.ts`)

Test database operations:

- [x] Event Repository
  - [x] CRUD operations
  - [x] Query operations
  - [x] Transaction handling
  - [x] Error handling

### 1.5 Cache Tests (`tests/event/cache.test.ts`)

Test caching operations:

- [x] Redis Operations
  - [x] Basic operations (get/set)
  - [x] TTL handling
  - [x] Serialization
  - [x] Error handling

## 2. Integration Tests

### 2.1 Service Integration (`tests/event/service.integration.test.ts`)

Test service layer coordination:

- [x] Service Operations

  - [x] Cache → DB flow
  - [x] API → Cache flow
  - [x] Error handling
  - [x] Data consistency

- [x] Event Methods
  - [x] getAllEvents
  - [x] getEvent
  - [x] getCurrentEvent
  - [x] getNextEvent

### 2.2 End-to-End Tests (`tests/event/e2e.test.ts`)

Test complete workflows:

- [x] Data Pipeline
  - [x] API → Cache → DB flow
  - [x] Error recovery
  - [x] Data consistency
  - [x] Resource cleanup

## 3. Test Environment

### 3.1 Configuration

- Uses `.env` for configuration
- Real infrastructure:
  - FPL API (rate limited)
  - Redis
  - PostgreSQL

### 3.2 Test Data Management

```typescript
// Test data isolation
beforeEach(async () => {
  testKeys = [];
  testIds = [];
});

afterEach(async () => {
  await cleanup(testKeys, testIds);
});
```

### 3.3 Test Execution

```bash
# Run tests
npm test tests/event

# Run specific suite
npm test tests/event/client.test.ts
```

## 4. Key Principles

1. **Real Dependencies**

   - Use actual API/DB/Cache
   - No mocks unless absolutely necessary
   - Clean up test data properly

2. **Flexible Validation**

   - Validate only required fields
   - Allow additional fields from API
   - Focus on business requirements

3. **Error Handling**

   - Test error scenarios
   - Verify recovery mechanisms
   - Check error propagation

4. **Resource Management**
   - Clean up test data
   - Handle rate limits
   - Manage connections properly
