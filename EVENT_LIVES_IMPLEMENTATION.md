# Event Lives Domain Implementation

## Overview
This document describes the complete implementation of the **event_lives** domain, following the project's DDD (Domain-Driven Design) and FP (Functional Programming) architecture.

## Data Source
- **FPL API Endpoint**: `https://fantasy.premierleague.com/api/event/${eventId}/live/`
- **Database Table**: `event_live` (already exists in Supabase)

## Architecture Layers

### 1. Domain Layer (`/src/domain/event-lives.ts`)
**Pure business logic and types**

- ✅ `EventLive` interface - Core domain type
- ✅ `EventLiveSchema` - Zod validation schema
- ✅ Validation functions: `validateEventLive`, `validateEventLives`, `safeValidateEventLive`
- ✅ Business logic functions:
  - `calculateTotalPoints()` - Calculate FPL points from stats
  - `hasPlayed()` - Check if player participated
  - `hasStarted()` - Check if player started
  - `cameOffBench()` - Check if player came as substitute
  - `hasCard()` - Check if player received yellow/red card
  - `wasSentOff()` - Check if player was sent off
  - `hasGoalInvolvement()` - Check for goals/assists
  - `hasBonusPoints()` - Check for bonus points
  - `isInDreamTeam()` - Check dream team selection
  - `getPerformanceSummary()` - Get complete performance overview

### 2. Types Layer (`/src/types/index.ts`)
**Raw API response types**

- ✅ `RawFPLEventLiveStats` - Raw stats from FPL API
- ✅ `RawFPLEventLiveElement` - Raw element data from FPL API
- ✅ `RawFPLEventLiveResponse` - Complete API response structure

### 3. Database Layer (`/src/db/schemas/event-lives.schema.ts`)
**Database schema (already existed)**

- ✅ `eventLive` table schema (Drizzle ORM)
- ✅ Unique constraint on `(eventId, elementId)`
- ✅ Indexes on `eventId` and `elementId`
- ✅ Type exports: `DbEventLive`, `DbEventLiveInsert`

### 4. Client Layer (`/src/clients/fpl.ts`)
**External API integration**

- ✅ `getEventLive(eventId)` method with:
  - Proper TypeScript return type
  - Zod validation for API response
  - Comprehensive error handling
  - Structured logging

### 5. Transformer Layer (`/src/transformers/event-lives.ts`)
**Data transformation between layers**

- ✅ `transformEventLive()` - Transform single element
- ✅ `transformEventLives()` - Transform array of elements
- Maps raw FPL data to domain `EventLive` type
- Handles nullable fields appropriately
- Converts `starts` from number to boolean

### 6. Repository Layer (`/src/repositories/event-lives.ts`)
**Data access operations**

Methods:
- ✅ `findByEventId(eventId)` - Get all live data for an event
- ✅ `findByEventAndElement(eventId, elementId)` - Get specific player's live data
- ✅ `findByElementId(elementId)` - Get player's live data across all events
- ✅ `upsert(eventLive)` - Insert or update single record
- ✅ `upsertBatch(eventLives)` - Batch insert/update with conflict resolution
- ✅ `deleteByEventId(eventId)` - Delete all records for an event

Features:
- Database error handling
- Structured logging
- Singleton pattern with dependency injection support

### 7. Cache Layer (`/src/cache/operations.ts` & `/src/cache/singleton.ts`)
**Redis caching strategy**

Cache Pattern: `EventLive:season:eventId` → hash of `elementId` → EventLive data

Operations:
- ✅ `getByEventId(eventId)` - Retrieve cached event live data
- ✅ `getByEventAndElement(eventId, elementId)` - Retrieve specific player's cached data
- ✅ `set(eventId, eventLives)` - Cache event live data with expiration
- ✅ `clearByEventId(eventId)` - Clear cache for specific event
- ✅ `clear()` - Clear all event lives cache

Configuration:
- ✅ `CACHE_TTL.EVENT_LIVE` = 120 seconds (2 minutes)
- Appropriate for live data that updates frequently during matches

### 8. Service Layer (`/src/services/event-lives.service.ts`)
**Business logic orchestration**

Methods:
- ✅ `getEventLivesByEventId(eventId)` - Cache-first retrieval strategy
- ✅ `getEventLiveByEventAndElement(eventId, elementId)` - Get specific player data
- ✅ `getEventLivesByElementId(elementId)` - Get player history across events
- ✅ `syncEventLives(eventId)` - Sync from FPL API to database and cache
- ✅ `clearEventLivesCache(eventId)` - Cache invalidation for event
- ✅ `clearAllEventLivesCache()` - Clear all cache

Caching Strategy:
1. Check Redis cache (fast path)
2. On cache miss → query database
3. Update cache asynchronously (non-blocking)

### 9. API Layer (`/src/api/event-lives.api.ts`)
**HTTP endpoints**

Routes:
- ✅ `GET /event-lives/event/:eventId` - Get all live data for an event
- ✅ `GET /event-lives/event/:eventId/element/:elementId` - Get specific player in event
- ✅ `GET /event-lives/element/:elementId` - Get player's history across events
- ✅ `POST /event-lives/sync/:eventId` - Trigger sync for specific event
- ✅ `DELETE /event-lives/cache/:eventId` - Clear cache for event
- ✅ `DELETE /event-lives/cache` - Clear all event lives cache

Features:
- Input validation (eventId, elementId)
- Proper HTTP status codes
- Consistent response format: `{ success, data, count/message }`
- Error handling

### 10. Application Layer (`/src/index.ts`)
**API registration**

- ✅ Imported `eventLivesAPI`
- ✅ Registered with Elysia app
- ✅ Added to startup log

## Data Flow

### Sync Flow (POST /event-lives/sync/:eventId)
```
FPL API → Client → Transformer → Repository → Database
                                              ↓
                                            Cache
```

### Read Flow (GET /event-lives/event/:eventId)
```
API → Service → Cache (hit) → Response
              ↓
            Cache (miss) → Repository → Database → Cache → Response
```

## Key Features

### Type Safety
- ✅ Full TypeScript types throughout the stack
- ✅ Zod validation for external data
- ✅ Domain types separate from database types

### Error Handling
- ✅ Custom error types: `DatabaseError`, `CacheError`, `FPLClientError`
- ✅ Structured error logging with context
- ✅ Graceful fallbacks (cache miss → database)

### Performance Optimization
- ✅ Cache-first strategy for reads
- ✅ Redis hash for efficient storage
- ✅ Batch upserts for bulk operations
- ✅ Async cache updates (non-blocking)

### Data Consistency
- ✅ Unique constraint prevents duplicates
- ✅ Upsert strategy handles updates gracefully
- ✅ Atomic batch operations

## Testing

### ✅ Unit Tests (`tests/unit/event-lives.test.ts`)
**60+ tests covering**:
- Transformers (transformEventLive, transformEventLives)
- Domain validation (validateEventLive, validateEventLives, safeValidateEventLive)
- Business logic (hasPlayed, hasStarted, cameOffBench, hasCard, etc.)
- Performance summary generation
- Repository structure
- Edge cases and error handling
- Performance benchmarks

**Run**: `bun test tests/unit/event-lives.test.ts`

### ✅ Integration Tests (`tests/integration/event-lives.test.ts`)
**30+ tests covering**:
- Full sync flow (FPL API → Transform → Database → Cache)
- Service layer operations
- Repository CRUD operations
- Cache-first strategy
- Database fallback
- Data consistency across layers
- Query performance
- Error handling

**Run**: `bun test tests/integration/event-lives.test.ts`

### ✅ Test Fixtures (`tests/fixtures/event-lives.fixtures.ts`)
**Comprehensive test data**:
- Mock FPL API responses
- Expected domain objects
- Edge cases (goalkeeper, red card, bench player)
- Various scenarios (empty, single, multiple)

**Run All Tests**: `bun test tests/unit/event-lives.test.ts tests/integration/event-lives.test.ts`

**See**: [Test Documentation](tests/README_EVENT_LIVES_TESTS.md) for details

## Usage Examples

### Sync live data for current gameweek
```bash
curl -X POST http://localhost:3000/event-lives/sync/15
```

### Get all live data for an event
```bash
curl http://localhost:3000/event-lives/event/15
```

### Get specific player's performance in an event
```bash
curl http://localhost:3000/event-lives/event/15/element/123
```

### Get player's history across all events
```bash
curl http://localhost:3000/event-lives/element/123
```

### Clear cache
```bash
curl -X DELETE http://localhost:3000/event-lives/cache/15
curl -X DELETE http://localhost:3000/event-lives/cache
```

## Database Schema

```sql
CREATE TABLE event_live (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  element_id INTEGER NOT NULL REFERENCES players(id),
  minutes INTEGER,
  goals_scored INTEGER,
  assists INTEGER,
  clean_sheets INTEGER,
  goals_conceded INTEGER,
  own_goals INTEGER,
  penalties_saved INTEGER,
  penalties_missed INTEGER,
  yellow_cards INTEGER,
  red_cards INTEGER,
  saves INTEGER,
  bonus INTEGER,
  bps INTEGER,
  starts BOOLEAN,
  expected_goals DECIMAL(10,2),
  expected_assists DECIMAL(10,2),
  expected_goal_involvements DECIMAL(10,2),
  expected_goals_conceded DECIMAL(10,2),
  mng_win INTEGER,
  mng_draw INTEGER,
  mng_loss INTEGER,
  mng_underdog_win INTEGER,
  mng_underdog_draw INTEGER,
  mng_clean_sheets INTEGER,
  mng_goals_scored INTEGER,
  in_dream_team BOOLEAN,
  total_points INTEGER DEFAULT 0 NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(event_id, element_id)
);

CREATE INDEX idx_event_live_element_id ON event_live(element_id);
```

## Cron Jobs (Future Enhancement)

Consider adding scheduled jobs:
- Sync live data every 2 minutes during match days
- Clear stale cache after matches finish
- Archive historical live data

## Monitoring & Logging

All operations include structured logging:
- Info level: Successful operations with counts
- Error level: Failures with full context
- Debug level: Cache hits/misses

Log categories:
- `fpl-client` - FPL API calls
- `repository` - Database operations
- `cache` - Redis operations
- `service` - Business logic flow

## Compliance

✅ Follows DDD principles (domain, service, repository layers)
✅ Adheres to FP patterns (pure functions, no classes in domain)
✅ Type-safe throughout (no `any` types)
✅ Consistent with project structure
✅ Proper separation of concerns
✅ Comprehensive error handling
✅ Structured logging with Pino
✅ Cache-first performance strategy

## Files Created/Modified

### Created Files
1. `/src/domain/event-lives.ts` - Domain logic and validation
2. `/src/transformers/event-lives.ts` - Data transformation
3. `/src/repositories/event-lives.ts` - Data access layer
4. `/src/services/event-lives.service.ts` - Business logic orchestration
5. `/src/api/event-lives.api.ts` - HTTP endpoints
6. `/tests/fixtures/event-lives.fixtures.ts` - Test data and fixtures
7. `/tests/unit/event-lives.test.ts` - Unit tests (60+ tests)
8. `/tests/integration/event-lives.test.ts` - Integration tests (30+ tests)

### Modified Files
1. `/src/types/index.ts` - Added raw FPL response types
2. `/src/clients/fpl.ts` - Added `getEventLive()` method with validation
3. `/src/cache/operations.ts` - Added `eventLivesCache` operations
4. `/src/cache/singleton.ts` - Added `CACHE_TTL.EVENT_LIVE` config
5. `/src/index.ts` - Registered event-lives API

### Documentation Files
1. `/EVENT_LIVES_IMPLEMENTATION.md` - Complete technical documentation
2. `/QUICK_START_EVENT_LIVES.md` - Quick reference guide
3. `/tests/README_EVENT_LIVES_TESTS.md` - Test documentation

### Existing Files (Used)
1. `/src/db/schemas/event-lives.schema.ts` - Database schema (already existed)
2. `/src/db/schemas/index.schema.ts` - Schema exports (already exported)

## Next Steps

1. ✅ All core functionality implemented
2. ✅ Unit tests for domain logic (60+ tests)
3. ✅ Integration tests for full flow (30+ tests)
4. ✅ Test fixtures and documentation
5. 🔄 Consider adding WebSocket support for real-time updates
6. 🔄 Add scheduled cron jobs for automatic syncing
7. 🔄 Add Swagger/OpenAPI documentation
8. 🔄 Add API endpoint tests (HTTP integration)
9. 🔄 Add load testing for high concurrency

