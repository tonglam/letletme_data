# Event Test Plan

This document outlines the test plan for the event functionality in the FPL data system. The tests are organized to ensure proper isolation of concerns while maintaining comprehensive coverage.

> **Important**: The test suite uses a combination of mock data and real dependencies to ensure both reliable testing and real-world behavior validation.

## 1. Unit Tests

### 1.1 FPL Client Tests (`tests/event/client.test.ts`)

Test FPL API client functionality with mock data:

- [x] Bootstrap Data Tests

  - [x] Return mock bootstrap data
  - [x] Validate data structure (events, phases, teams, elements arrays)
  - [x] Verify mock data matches expected data
  - [x] Validate required fields in event data
    - id, name, deadline_time
    - is_current, is_next, is_previous
    - finished status

- [x] Error Handling Tests
  - [x] Handle rate limit errors (429 status)
  - [x] Handle timeout errors (408 status)
  - [x] Handle retry and recovery scenarios
    - Test sequence: error → error → success
    - Verify retry attempts
    - Confirm successful recovery

### 1.2 Domain Tests (`tests/event/domain.test.ts`)

Test domain logic and business rules:

- [x] Event Domain Model Transformation

  - [x] Transform API response to domain model
  - [x] Validate required fields (id, name, deadline_time)
  - [x] Validate data types and formats
  - [x] Handle optional fields gracefully

- [x] Event State Management

  - [x] Validate event state transitions (previous, current, next)
  - [x] Verify state exclusivity (only one event in each state)
  - [x] Validate state relationships
  - [x] Test state transitions correctness

- [x] Business Logic Constraints

  - [x] Finished events should be in the past
  - [x] Future events should not be finished or data_checked
  - [x] Validate chronological order of deadlines
  - [x] Test event lifecycle rules

- [x] Event Aggregates
  - [x] Validate sequential event IDs (1 to 38)
  - [x] Verify gameweek naming convention
  - [x] Test chronological ordering
  - [x] Validate relationships between events

### 1.3 Repository Tests (`tests/event/repository.test.ts`)

Test database operations with real bootstrap data:

- [x] Event Repository CRUD Operations

  - [x] Create single event with validation
  - [x] Create multiple events in batch
  - [x] Find event by ID with proper type safety
  - [x] Find multiple events by IDs
  - [x] Update event with partial data
  - [x] Delete event with verification
  - [x] Find all events with pagination

- [x] Special Query Operations

  - [x] Find current event (isCurrent flag)
  - [x] Find next event (isNext flag)
  - [x] Handle JSON fields properly (chipPlays, topElementInfo)
  - [x] Validate EventId branded type

- [x] Data Integrity

  - [x] Proper cleanup before and after tests
  - [x] Verify all event fields after operations
  - [x] Handle null and optional fields correctly
  - [x] Maintain data consistency in transactions

- [x] Error Handling & Type Safety

  - [x] Use Either type for error handling
  - [x] Proper type validation for EventId
  - [x] Handle JSON serialization/deserialization
  - [x] Follow functional programming principles

- [x] Test Data Management
  - [x] Use real data from bootstrap.json
  - [x] Proper test isolation
  - [x] Clean database state between tests
  - [x] Track created records for cleanup

### 1.4 Cache Tests (`tests/event/cache.test.ts`)

Test caching operations:

- [x] Basic Cache Operations

  - [x] Set and get single event
  - [x] Set and get multiple events
  - [x] Cache miss handling with data provider fallback
  - [x] Current and next event caching
  - [x] Warm up cache with initial data

- [x] Error Handling & Edge Cases

  - [x] Handle error cases gracefully (data provider errors)
  - [x] Handle empty event data
  - [x] Handle malformed event data
  - [x] Handle concurrent cache operations

- [x] Configuration & Setup

  - [x] Handle different seasons and key prefixes
  - [x] Proper cleanup before and after tests
  - [x] Redis key management
  - [x] Test isolation

- [x] Data Integrity

  - [x] Consistent event comparison
  - [x] Order-independent array comparison
  - [x] Proper serialization/deserialization
  - [x] Detailed mismatch logging

- [x] Mock Data Provider
  - [x] Fallback for cache misses
  - [x] Verify provider call counts
  - [x] Mock different response scenarios
  - [x] Test provider integration

## 2. Integration Tests

### 2.1 Real API Tests (`tests/event/client.integration.test.ts`)

Test actual FPL API interactions:

- [x] Client Setup

  - [x] Initialize axios client with proper configuration
  - [x] Configure retry settings
  - [x] Create bootstrap adapter with FPL client

- [x] Successful Data Fetching

  - [x] Events Data Validation
    - [x] Array structure and non-empty check
    - [x] Required fields validation
    - [x] Date format validation
  - [x] Phases Data Validation
    - [x] Array structure and non-empty check
    - [x] Required fields validation
    - [x] Phase range validation
  - [x] Teams Data Validation
    - [x] Array structure and non-empty check
    - [x] Required fields validation
    - [x] Team strength range validation
  - [x] Elements Data Validation
    - [x] Array structure and non-empty check
    - [x] Required fields validation
    - [x] Non-negative numeric values

- [x] Caching Behavior

  - [x] Cache bootstrap data on first call
  - [x] Use cached data on subsequent calls
  - [x] Verify API is called only once

- [x] Error Handling
  - [x] Rate limiting with exponential backoff
  - [x] Temporary failures with retry mechanism
  - [x] Network errors handling
  - [x] Detailed error logging

### 2.2 Service Integration Tests (`tests/event/service.integration.test.ts`)

Test service layer integration with domain operations:

- [ ] Service Setup & Configuration

  - [ ] Initialize service with proper dependencies
  - [ ] Verify service type safety
  - [ ] Test dependency injection
  - [ ] Validate service interface compliance

- [ ] Core Service Operations

  - [ ] Event Retrieval
    - [ ] Get all events with proper error mapping
    - [ ] Get single event by ID
    - [ ] Get current event
    - [ ] Get next event
  - [ ] Event Creation
    - [ ] Save single event
    - [ ] Save multiple events
  - [ ] API Integration
    - [ ] Sync events from API
    - [ ] Handle API errors properly
    - [ ] Verify data transformation

- [ ] Error Handling & Type Safety

  - [ ] Map domain errors to service errors
  - [ ] Handle repository errors
  - [ ] Handle cache errors
  - [ ] Maintain type safety across layers

- [ ] Service State Management
  - [ ] Proper cleanup between tests
  - [ ] Handle service initialization
  - [ ] Manage test resources
  - [ ] Verify service isolation

### 2.3 Workflow Integration Tests (`tests/event/workflow.integration.test.ts`)

Test workflow orchestration and execution:

- [ ] Workflow Setup

  - [ ] Initialize workflows with service
  - [ ] Verify workflow context creation
  - [ ] Test workflow type safety
  - [ ] Validate workflow interface compliance

- [ ] Workflow Operations

  - [ ] Event Sync Workflow
    - [ ] Execute complete sync workflow
    - [ ] Verify workflow context tracking
    - [ ] Validate workflow metrics
    - [ ] Test workflow result structure

- [ ] Error Handling & Logging

  - [ ] Handle service errors in workflows
  - [ ] Verify error context enrichment
  - [ ] Test logging integration
  - [ ] Validate error propagation

- [ ] Workflow Metrics & Monitoring

  - [ ] Track workflow duration
  - [ ] Measure operation counts
  - [ ] Monitor workflow state
  - [ ] Validate performance metrics

## 3. Test Environment

### 3.1 Configuration

- Uses `.env` for configuration
- Mixed infrastructure:
  - Mock data in `tests/data/bootstrap.json` for unit tests
  - Real FPL API for integration tests

### 3.2 Test Data Management

- Unit tests:

  - Use mock data for predictable results
  - Test error scenarios with controlled responses
  - Validate business logic in isolation

- Integration tests:
  - Use real API responses
  - Handle actual network conditions
  - Validate real-world behavior

### 3.3 Test Execution

#### Test Organization

```bash
tests/event/
├── client.test.ts           # Unit tests for FPL client
├── domain.test.ts           # Unit tests for event domain logic
├── repository.test.ts       # Unit tests for event repository
├── cache.test.ts           # Unit tests for event caching
├── client.integration.test.ts  # Integration tests for FPL API
├── service.integration.test.ts # Integration tests for event service
└── workflow.integration.test.ts # Integration tests for event workflows
```

#### Running Tests

```bash
# Run all event tests
npm test tests/event

# Run specific test suites
npm test tests/event/client.test.ts         # Run client unit tests
npm test tests/event/domain.test.ts         # Run domain unit tests
npm test tests/event/repository.test.ts     # Run repository unit tests
npm test tests/event/cache.test.ts         # Run cache unit tests

# Run integration tests
npm test tests/event/client.integration.test.ts    # Run API integration tests
npm test tests/event/service.integration.test.ts   # Run service integration tests
npm test tests/event/workflow.integration.test.ts  # Run workflow integration tests

# Run all unit tests
npm test "tests/event/*.test.ts"

# Run all integration tests
npm test "tests/event/*.integration.test.ts"

# Run tests with coverage
npm test -- --coverage tests/event

# Run tests in watch mode (during development)
npm test -- --watch tests/event
```

#### Test Environment Setup

1. **Local Development**

   ```bash
   # Setup test database
   npm run db:test:setup

   # Start Redis for testing
   docker-compose -f docker-compose.test.yml up -d redis

   # Run tests
   npm test
   ```

2. **CI Environment**

   ```bash
   # Install dependencies
   npm ci

   # Setup test infrastructure
   docker-compose -f docker-compose.test.yml up -d

   # Run migrations
   npm run db:test:migrate

   # Run all tests with coverage
   npm test -- --coverage --ci
   ```

#### Test Debugging

```bash
# Run tests with verbose output
npm test -- --verbose tests/event

# Debug specific test file
npm test -- --runInBand --detectOpenHandles tests/event/service.integration.test.ts

# Run tests with increased timeout
npm test -- --testTimeout=30000 tests/event/workflow.integration.test.ts
```

#### Best Practices

1. **Test Organization**

   - Keep unit tests and integration tests separate
   - Use consistent file naming convention
   - Group related tests in describe blocks
   - Use meaningful test descriptions

2. **Test Execution**

   - Run unit tests before integration tests
   - Use appropriate timeouts for async tests
   - Clean up resources after tests
   - Handle test database state properly

3. **Test Maintenance**
   - Update tests when changing functionality
   - Keep test coverage high
   - Document complex test setups
   - Use test utilities for common operations

## 4. Key Principles

1. **Test Isolation**

   - Unit tests use mock data exclusively
   - Integration tests use real dependencies
   - Clear separation between test types
   - Separate service and workflow testing

2. **Error Handling**

   - Mock error scenarios in unit tests
   - Handle real errors in integration tests
   - Verify both expected and unexpected cases
   - Test error mapping between layers

3. **Data Validation**

   - Consistent validation across test types
   - Verify data structures thoroughly
   - Log detailed information for debugging
   - Validate workflow context and metrics

4. **Code Quality**
   - Follow TypeScript best practices
   - Maintain test readability
   - Document test cases clearly
   - Ensure type safety across layers
