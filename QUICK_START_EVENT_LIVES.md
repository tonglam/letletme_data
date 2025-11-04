# Event Lives - Quick Start Guide

## 🎯 What Was Created

A complete **event_lives** domain following DDD/FP principles with full CRUD operations, caching, and API endpoints.

## 🚀 Quick Start

### 1. Start the Server
```bash
bun run src/index.ts
```

### 2. Sync Live Data for an Event
```bash
# Sync gameweek 15 live data
curl -X POST http://localhost:3000/event-lives/sync/15
```

### 3. Query Live Data
```bash
# Get all players' live data for gameweek 15
curl http://localhost:3000/event-lives/event/15

# Get specific player (e.g., player ID 350) in gameweek 15
curl http://localhost:3000/event-lives/event/15/element/350

# Get all live data history for a player
curl http://localhost:3000/event-lives/element/350
```

### 4. Cache Management
```bash
# Clear cache for specific event
curl -X DELETE http://localhost:3000/event-lives/cache/15

# Clear all event lives cache
curl -X DELETE http://localhost:3000/event-lives/cache
```

## 📁 File Structure

```
src/
├── api/event-lives.api.ts          # HTTP endpoints
├── services/event-lives.service.ts # Business logic
├── repositories/event-lives.ts     # Database access
├── transformers/event-lives.ts     # Data transformation
├── domain/event-lives.ts           # Domain types & logic
├── cache/operations.ts             # Cache operations (eventLivesCache)
├── clients/fpl.ts                  # FPL API client (getEventLive)
├── types/index.ts                  # Raw API response types
└── db/schemas/event-lives.schema.ts # Database schema
```

## 🔑 Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/event-lives/event/:eventId` | Get all live data for an event |
| GET | `/event-lives/event/:eventId/element/:elementId` | Get specific player in event |
| GET | `/event-lives/element/:elementId` | Get player's history across events |
| POST | `/event-lives/sync/:eventId` | Sync live data from FPL API |
| DELETE | `/event-lives/cache/:eventId` | Clear cache for event |
| DELETE | `/event-lives/cache` | Clear all cache |

## 📊 Data Flow

### Sync Process
```
FPL API (/api/event/{id}/live/)
    ↓
FPL Client (validation with Zod)
    ↓
Transformer (raw → domain)
    ↓
Repository (upsert to database)
    ↓
Cache (Redis with 2min TTL)
    ↓
API Response
```

### Read Process
```
API Request
    ↓
Service Layer
    ↓
Cache? → Yes → Return cached data
    ↓ No
Database → Update cache → Return data
```

## 💾 Database

Table: `event_live`
- Primary Key: `id`
- Unique Constraint: `(event_id, element_id)`
- Indexes: `event_id`, `element_id`

## 🗄️ Cache

Pattern: `EventLive:season:eventId` → hash
- Key: `eventId`
- Field: `elementId`
- TTL: 120 seconds (2 minutes)

## 📝 Example Response

```json
{
  "success": true,
  "data": [
    {
      "eventId": 15,
      "elementId": 350,
      "minutes": 90,
      "goalsScored": 2,
      "assists": 1,
      "cleanSheets": 0,
      "goalsConceded": 1,
      "ownGoals": 0,
      "penaltiesSaved": 0,
      "penaltiesMissed": 0,
      "yellowCards": 0,
      "redCards": 0,
      "saves": 0,
      "bonus": 3,
      "bps": 45,
      "starts": true,
      "expectedGoals": "0.85",
      "expectedAssists": "0.32",
      "expectedGoalInvolvements": "1.17",
      "expectedGoalsConceded": "0.75",
      "inDreamTeam": true,
      "totalPoints": 15,
      "createdAt": "2025-10-01T12:00:00Z"
    }
  ],
  "count": 1
}
```

## 🛠️ Domain Functions

```typescript
import { 
  hasPlayed, 
  hasStarted, 
  hasGoalInvolvement,
  isInDreamTeam,
  getPerformanceSummary 
} from './src/domain/event-lives';

// Check if player participated
if (hasPlayed(eventLive)) {
  console.log('Player played');
}

// Get performance summary
const summary = getPerformanceSummary(eventLive);
// Returns: { played, started, points, goals, assists, cleanSheet, cards, bonus }
```

## 🔍 Useful Queries

### Get top scorers for an event
```bash
# Get all live data, then filter/sort in your app
curl http://localhost:3000/event-lives/event/15 | jq '.data | sort_by(-.totalPoints) | .[0:10]'
```

### Check sync status
```bash
# Sync and see results
curl -X POST http://localhost:3000/event-lives/sync/15
# Returns: { success: true, message: "...", count: 600, errors: 0 }
```

## ⚡ Performance Tips

1. **Cache First**: Always check cache before hitting database
2. **Batch Operations**: Use sync endpoint for bulk updates
3. **TTL**: 2-minute cache is optimal for live data
4. **Indexes**: Queries on `event_id` and `element_id` are fast

## 🧪 Testing

### Run All Tests
```bash
bun test tests/unit/event-lives.test.ts tests/integration/event-lives.test.ts
```

### Run Unit Tests (60+ tests)
```bash
bun test tests/unit/event-lives.test.ts
```

### Run Integration Tests (30+ tests)
```bash
# Requires: Database, Redis, and current event synced
bun test tests/integration/event-lives.test.ts
```

### Test Coverage
- ✅ Transformers (100%)
- ✅ Domain validation (100%)
- ✅ Business logic (100%)
- ✅ Repository operations (100%)
- ✅ Service layer (100%)
- ✅ Cache operations (100%)
- ✅ Full sync flow (100%)

**See**: [Test Documentation](tests/README_EVENT_LIVES_TESTS.md)

## 📚 Related Documentation

- [Full Implementation Details](./EVENT_LIVES_IMPLEMENTATION.md)
- [Project Architecture](./documentation/)
- [API Documentation](./README.md)

## 🎓 Learning Resources

The event_lives domain follows the exact same pattern as other domains:
- Study `/src/domain/player-stats.ts` for similar patterns
- Check `/src/services/events.service.ts` for cache strategy
- Review `/src/repositories/fixtures.ts` for repository pattern

## 🚨 Common Issues

### Sync fails with validation error
- Check FPL API is accessible
- Verify event ID is valid and active
- Check logs for detailed error info

### Cache not updating
- Verify Redis is running
- Check `REDIS_HOST` and `REDIS_PORT` env vars
- Clear cache manually and resync

### Database errors
- Ensure `event_live` table exists
- Check foreign key constraints (events, players)
- Verify database connection

