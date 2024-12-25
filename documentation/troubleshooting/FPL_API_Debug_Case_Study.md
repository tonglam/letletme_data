# FPL API Integration Debug Case Study

## Issue Overview

The team sync process was failing due to type mismatches between the FPL API response and our application's type definitions.

## Debugging Steps Taken

### 1. Initial Investigation

- Identified that the team sync process was failing
- Created and used test scripts:

  ```bash
  # First, checked existing data
  npx ts-node src/scripts/check-events.ts

  # Then, tested team sync in isolation
  npx ts-node src/scripts/test-team-sync.ts
  ```

- Verified database connection was working
- Used structured logging to track the process

### 2. API Accessibility Check

```bash
# Direct API test
curl -H "User-Agent: Mozilla/5.0" -H "Accept: application/json" https://fantasy.premierleague.com/api/bootstrap-static/

# Then used our script to test the complete flow
npx ts-node src/scripts/trigger-events-sync.ts
```

- Confirmed API was accessible
- Received valid JSON response
- Analyzed actual response structure
- Verified our client could connect

### 3. Type Definition Analysis

- Found mismatch between API response and our type definitions
- Issues identified:
  - Required vs optional fields mismatch
  - Snake_case vs camelCase inconsistencies
  - Missing field transformations

### 4. Code Changes Made

#### a. Updated BootstrapData Interface

```typescript
export interface BootstrapData {
  teams: TeamResponse[];
  phases: Array<{
    id: number;
    name: string;
    start_event: number;
    stop_event: number;
  }>;
  events: Array<{
    // ... event fields
  }>;
}
```

#### b. Fixed Team Response Schema

```typescript
const TeamResponseSchema = z.object({
  id: z.number(),
  code: z.number(),
  name: z.string(),
  short_name: z.string(),
  strength: z.number(),
  // Made optional fields optional
  strength_overall_home: z.number().optional(),
  // ... other fields
});
```

#### c. Improved Transformation Logic

```typescript
export const toDomainTeam = (raw: TeamResponse): Either<string, Team> => {
  try {
    if (!isTeamId(raw.id)) {
      return left(`Invalid team ID: ${raw.id}`);
    }
    const team: Team = {
      id: raw.id as TeamId,
      // Added default values for optional fields
      strengthOverallHome: raw.strength_overall_home ?? 0,
      // ... other fields
    };
    return right(team);
  } catch (error) {
    return left(`Failed to transform team data: ${error}`);
  }
};
```

### 5. Testing and Verification

- Created comprehensive test script
- Added logging at key points
- Verified each step:
  1. Database connection
  2. API data fetch
  3. Data transformation
  4. Database operations

## Key Learnings

1. **Type Safety**

   - Always verify API response structure before defining types
   - Use optional fields when uncertain about data presence
   - Provide sensible defaults for optional fields

2. **Testing Approach**

   - Create isolated test scripts
   - Test each integration point separately
   - Add comprehensive logging
   - Verify data at each transformation step

3. **Error Handling**

   - Use functional error handling (Either/TaskEither)
   - Provide detailed error messages
   - Log errors with context
   - Handle both expected and unexpected cases

4. **Code Organization**
   - Separate concerns (API client, transformation, business logic)
   - Use proper typing for each layer
   - Maintain clear boundaries between layers

## Results

- Successfully fixed team sync process
- Improved type safety
- Better error handling
- More maintainable code
- Added comprehensive testing

## Future Recommendations

1. **API Response Validation**

   - Add runtime validation for API responses
   - Consider using OpenAPI/Swagger definitions
   - Implement response caching for stability

2. **Monitoring**

   - Add metrics for API response times
   - Monitor transformation success rates
   - Track data consistency

3. **Documentation**
   - Keep API response examples updated
   - Document type transformation rules
   - Maintain troubleshooting guides

## Testing and Verification Process

### 1. Initial Testing

```bash
# Basic data check
npx ts-node src/scripts/check-events.ts
```

- Verified current database state
- Checked for existing data integrity

### 2. Comparison Testing

```bash
# Compare API and database data
npx ts-node src/scripts/compare-events.ts
```

- Identified data discrepancies
- Verified transformation accuracy

### 3. Integration Testing

```bash
# Test complete sync process
npx ts-node src/scripts/test-team-sync.ts
```

- Verified end-to-end flow
- Confirmed all components working

### 4. System Testing

```bash
# Final verification
npx ts-node src/scripts/start-and-sync.ts
```

- Tested in production-like environment
- Verified complete system integration

## Debugging Tools Used

### 1. Custom Scripts

- `test-team-sync.ts`: Main debugging tool
- `check-events.ts`: Data verification
- `compare-events.ts`: Data consistency checks
- `trigger-events-sync.ts`: Manual testing
- `start-and-sync.ts`: System integration testing

### 2. Logging

```typescript
logger.info({ count: teams.length }, 'Successfully synced teams');
logger.error({ error }, 'Failed to sync teams');
```

- Used pino for structured logging
- Added context to all log messages
- Tracked process flow
