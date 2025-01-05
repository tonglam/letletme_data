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

- [x] Redis Operations
  - [x] Basic operations (get/set)
  - [x] TTL handling
  - [x] Serialization
  - [x] Error handling

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

```bash
# Run unit tests with mocks
npm test tests/event/client.test.ts

# Run integration tests with real API
npm test tests/event/client.integration.test.ts

# Run all tests
npm test tests/event
```

## 4. Key Principles

1. **Test Isolation**

   - Unit tests use mock data exclusively
   - Integration tests use real API exclusively
   - Clear separation between test types

2. **Error Handling**

   - Mock error scenarios in unit tests
   - Handle real API errors in integration tests
   - Verify both expected and unexpected cases

3. **Data Validation**

   - Consistent validation across test types
   - Verify data structures thoroughly
   - Log detailed information for debugging

4. **Code Quality**
   - Follow TypeScript best practices
   - Maintain test readability
   - Document test cases clearly
