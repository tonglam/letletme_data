# Event Test Plan

This document outlines the test plan for the event functionality in the FPL data system. The tests are organized to ensure proper isolation of concerns while maintaining comprehensive coverage.

> **Important**: The test suite uses a combination of mock data and real dependencies to ensure both reliable testing and real-world behavior validation.

## 1. Unit Tests

### 1.1 Route Tests (`tests/event/route.test.ts`)

Test API routes and handlers:

- [x] Route Configuration

  - [x] Verify router setup and middleware
  - [x] Test route parameter validation
  - [x] Validate request handling
  - [x] Test error middleware integration

- [x] Route Handlers

  - [x] GET /events
    - [x] Return all events successfully
    - [x] Handle service errors (503 status)
    - [x] Validate response structure with data wrapper
  - [x] GET /events/current
    - [x] Return current event with data wrapper
    - [x] Handle not found case (404 status)
    - [x] Validate response format
  - [x] GET /events/next
    - [x] Return next event with data wrapper
    - [x] Handle not found case (404 status)
    - [x] Validate response structure
  - [x] GET /events/:id
    - [x] Return specific event by ID with data wrapper
    - [x] Validate ID parameter (400 status for invalid format)
    - [x] Handle non-existent event (404 status)
    - [x] Handle service errors (503 status)

- [x] Error Handling

  - [x] Test validation middleware (400 status)
  - [x] Handle service layer errors (503 status)
  - [x] Handle not found errors (404 status)
  - [x] Verify error response format
    - [x] Consistent error object structure
    - [x] Proper error codes (VALIDATION_ERROR, NOT_FOUND, SERVICE_ERROR)
    - [x] Descriptive error messages

- [x] Response Format
  - [x] Success responses wrapped in data object
  - [x] Error responses with error object
  - [x] Validate Content-Type header
  - [x] Verify HTTP status codes match error types

### 1.2 FPL Client Tests (`tests/event/client.test.ts`)

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

### 1.3 Domain Tests (`tests/event/domain.test.ts`)

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

### 1.4 Repository Tests (`tests/event/repository.test.ts`)

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

### 1.5 Cache Tests (`tests/event/cache.test.ts`)

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

- [x] Service Setup & Configuration

  - [x] Initialize service with proper dependencies
  - [x] Verify service type safety
  - [x] Test dependency injection
  - [x] Validate service interface compliance

- [x] Core Service Operations

  - [x] Event Retrieval
    - [x] Get all events with proper error mapping
    - [x] Get single event by ID
    - [x] Get current event
    - [x] Get next event
  - [x] Event Creation
    - [x] Save single event
    - [x] Save multiple events
  - [x] API Integration
    - [x] Sync events from API
    - [x] Handle API errors properly
    - [x] Verify data transformation

- [x] Error Handling & Type Safety

  - [x] Map domain errors to service errors
  - [x] Handle repository errors
  - [x] Handle cache errors
  - [x] Maintain type safety across layers

- [x] Service State Management
  - [x] Proper cleanup between tests
  - [x] Handle service initialization
  - [x] Manage test resources
  - [x] Verify service isolation

### 2.3 Workflow Integration Tests (`tests/event/workflow.integration.test.ts`)

Test workflow orchestration and execution:

- [x] Workflow Setup

  - [x] Initialize workflows with service
  - [x] Verify workflow context creation
  - [x] Test workflow type safety
  - [x] Validate workflow interface compliance

- [x] Workflow Operations

  - [x] Event Sync Workflow
    - [x] Execute complete sync workflow
    - [x] Verify workflow context tracking
    - [x] Validate workflow metrics
    - [x] Test workflow result structure

- [x] Error Handling & Logging

  - [x] Handle service errors in workflows
  - [x] Verify error context enrichment
  - [x] Test logging integration
  - [x] Validate error propagation

- [x] Workflow Metrics & Monitoring

  - [x] Track workflow duration
  - [x] Measure operation counts
  - [x] Monitor workflow state
  - [x] Validate performance metrics

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

### 3.4 Additional Notes

1. **Error System Improvements**

   - Current error chain testing is simplified to top-level errors
   - Plan to refactor error system for better error chain handling
   - Need to improve error type safety and propagation
   - Consider adding error context enrichment

2. **Test Coverage**

   - All test suites are implemented and passing
   - Unit tests have good isolation with mock data
   - Integration tests verify real-world behavior
   - Error handling coverage needs improvement

3. **Future Improvements**
   - Enhance error chain testing
   - Add more edge cases for error scenarios
   - Improve test performance and isolation
   - Consider adding stress testing for workflows

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
