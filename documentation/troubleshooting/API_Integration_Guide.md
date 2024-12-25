# API Integration Troubleshooting Guide

## Overview

This guide outlines the systematic approach to troubleshooting API integration issues, based on our experience debugging the FPL API integration.

## Step-by-Step Debugging Process

### 1. Verify API Accessibility

- First, test the API endpoint directly using `curl` or similar tools
- Include all necessary headers that the API requires
- Check the response status and data structure
- Example:

```bash
curl -H "User-Agent: Mozilla/5.0" -H "Accept: application/json" https://api-endpoint.com
```

### 2. Check Type Definitions

- Verify that your type definitions match the actual API response
- Common issues:
  - Missing required fields
  - Incorrect field types
  - Snake_case vs camelCase mismatches
  - Optional fields not properly marked
- Use tools like Zod for runtime validation

### 3. Validate API Client Configuration

- Check client setup:
  - Base URL configuration
  - Headers configuration
  - Retry logic
  - Error handling
- Ensure interceptors are properly configured
- Verify timeout settings

### 4. Debug Data Transformation

- Check transformation functions:
  - Input validation
  - Error handling
  - Type conversion
  - Default values for optional fields
- Use proper error types and messages
- Implement logging at key points

### 5. Test Integration Points

- Create test scripts to verify each step:
  - API connection
  - Data fetching
  - Data transformation
  - Database operations
- Log intermediate results
- Handle edge cases

## Common Issues and Solutions

### 1. Type Mismatches

```typescript
// Problem: API response doesn't match expected types
interface ApiResponse {
  short_name: string; // Required in type but optional in API
}

// Solution: Make fields optional and provide defaults
interface ApiResponse {
  short_name?: string;
}
const transformed = {
  shortName: raw.short_name ?? defaultValue,
};
```

### 2. Data Transformation Errors

```typescript
// Problem: Unsafe transformation
const transform = (data: ApiResponse) => ({
  id: data.id, // Might fail if id is invalid
});

// Solution: Add validation and error handling
const transform = (data: ApiResponse): Either<Error, Result> => {
  try {
    if (!isValidId(data.id)) {
      return left(new Error('Invalid ID'));
    }
    return right({ id: data.id });
  } catch (error) {
    return left(error);
  }
};
```

### 3. Error Handling

```typescript
// Problem: Generic error handling
catch (error) {
  return null;
}

// Solution: Detailed error handling with logging
catch (error) {
  logger.error({ error, context: 'API Call' }, 'Operation failed');
  return TE.left(createError('Specific error message', error));
}
```

## Best Practices

1. **Type Safety**

   - Use strict TypeScript configurations
   - Avoid type 'any'
   - Use branded types for IDs and other special values
   - Validate data at runtime using Zod or similar

2. **Error Handling**

   - Use functional error handling (Either/TaskEither)
   - Provide detailed error messages
   - Include context in error logs
   - Handle both expected and unexpected errors

3. **Testing**

   - Create dedicated test scripts
   - Test each integration point separately
   - Include error cases in tests
   - Log intermediate results

4. **Monitoring**
   - Implement comprehensive logging
   - Track API response times
   - Monitor error rates
   - Set up alerts for critical failures

## Debugging Tools

1. **API Testing**

   - curl for direct API testing
   - Postman for API exploration
   - jq for JSON response parsing

2. **Code Analysis**

   - TypeScript compiler
   - ESLint for static analysis
   - VS Code debugging tools

3. **Logging**
   - pino for structured logging
   - correlation IDs for request tracking
   - request/response interceptors

## Debugging Scripts

Our codebase includes several utility scripts for debugging and testing:

### 1. Test Team Sync (`test-team-sync.ts`)

```bash
npx ts-node src/scripts/test-team-sync.ts
```

- Tests the complete team sync process
- Verifies:
  - Database connection
  - API data fetching
  - Data transformation
  - Database operations
- Provides detailed logging at each step

### 2. Check Events (`check-events.ts`)

```bash
npx ts-node src/scripts/check-events.ts
```

- Verifies event data in the database
- Shows total number of events
- Displays event details for inspection

### 3. Compare Events (`compare-events.ts`)

```bash
npx ts-node src/scripts/compare-events.ts
```

- Compares events between API and database
- Identifies discrepancies
- Helps validate data consistency

### 4. Trigger Events Sync (`trigger-events-sync.ts`)

```bash
npx ts-node src/scripts/trigger-events-sync.ts
```

- Manually triggers event synchronization
- Tests API connectivity
- Verifies sync process

### 5. Start and Sync (`start-and-sync.ts`)

```bash
npx ts-node src/scripts/start-and-sync.ts
```

- Starts the application with sync
- Tests complete system integration
- Verifies all components working together

### Using the Scripts

1. **For API Issues**

   ```bash
   # Test API connectivity and data fetching
   npx ts-node src/scripts/test-team-sync.ts
   ```

2. **For Data Validation**

   ```bash
   # Check existing data
   npx ts-node src/scripts/check-events.ts

   # Compare with API data
   npx ts-node src/scripts/compare-events.ts
   ```

3. **For System Integration**

   ```bash
   # Test complete system
   npx ts-node src/scripts/start-and-sync.ts
   ```

4. **For Manual Sync**
   ```bash
   # Trigger sync process
   npx ts-node src/scripts/trigger-events-sync.ts
   ```

### Best Practices for Using Scripts

1. **Systematic Approach**

   - Start with basic checks (`check-events.ts`)
   - Move to comparison (`compare-events.ts`)
   - Test specific functionality (`test-team-sync.ts`)
   - Verify complete system (`start-and-sync.ts`)

2. **Logging Analysis**

   - Check logs for each script
   - Look for specific error messages
   - Verify success conditions
   - Monitor performance metrics

3. **Troubleshooting Flow**
   - Use scripts in isolation first
   - Combine scripts as needed
   - Follow error trails
   - Document findings

## Conclusion

Successful API integration requires a systematic approach to debugging, strong typing, proper error handling, and comprehensive testing. Following this guide will help identify and resolve issues quickly and effectively.
