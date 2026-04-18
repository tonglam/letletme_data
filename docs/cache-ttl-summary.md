# Cache TTL Summary

All cache TTL (Time To Live) configurations in seconds.

**Note:** TTL -1 means no expiration (cache persists indefinitely until manually deleted).

## Cache TTL Values (No Expiration Strategy)

| Cache Type | TTL (seconds) | TTL (human) | Cache Key Pattern | Category |
|------------|---------------|-------------|-------------------|----------|
| **EVENTS** | -1 | No expiration | `Event:{season}` | Basic/Static |
| **TEAMS** | -1 | No expiration | `Team:{season}` | Basic/Static |
| **PHASES** | -1 | No expiration | `Phase:{season}` | Basic/Static |
| **PLAYERS** | -1 | No expiration | `Player:{season}` | Basic/Static |
| **FIXTURES** | -1 | No expiration | `Fixtures:{season}:{eventId}` | Game Data |
| **PLAYER_STATS** | -1 | No expiration | `PlayerStat:{season}` | Game Data |
| **player_values** | -1 | No expiration | `PlayerValue:{changeDate}` | Game Data |
| **EVENT_LIVE** | -1 | No expiration | `EventLive:{season}:{eventId}` | Live Match Data |
| **EVENT_LIVE_EXPLAIN** | -1 | No expiration | `EventLiveExplain:{season}:{eventId}` | Live Match Data |
| **LIVE_FIXTURE** | -1 | No expiration | `LiveFixture:{season}:{eventId}` | Live Match Data |
| **LIVE_BONUS** | -1 | No expiration | `LiveBonus:{season}:{eventId}` | Live Match Data |
| **EVENT_LIVE_SUMMARY** | -1 | No expiration | `EventLiveSummary:{season}:{eventId}` | Aggregated Data |
| **EVENT_OVERALL_RESULT** | -1 | No expiration | `EventOverallResult:{season}` | Aggregated Data |
| **EVENT_STANDINGS** | -1 | No expiration | `EventStandings:{season}` | Aggregated Data |
| **LIVE_DATA** | -1 | No expiration | N/A | Live Match Data |

## Default Cache Config

- **DEFAULT_CACHE_CONFIG.ttl**: 300 seconds (5 minutes)
  - Used by generic cache operations when no specific TTL is provided

## TTL Strategy Rationale

### Why No Expiration (TTL -1)?
Since **read operations don't update the cache** (only sync operations do), using TTL -1 (no expiration) ensures:
- **No cache misses** - Cache persists indefinitely until manually cleared
- **Consistent performance** - No unexpected cache expiration
- **Reduced database load** - Cache always available
- **Predictable behavior** - Cache only updates during sync operations

### Cache Update Strategy
- **Delete before insert**: All cache `set()` operations delete the existing key before inserting new data
- **Sync-only updates**: Caches are updated by scheduled sync jobs (not by read operations)
- **Manual cleanup**: Caches can be manually cleared when needed (e.g., during data migrations or when stale data is detected)

### Cache Operations
All cache `set()` methods follow this pattern:
1. Delete existing cache key (`del(key)`)
2. Insert new data (`hset(key, data)`)
3. Set expiration only if TTL > 0 (skip if TTL is -1)

This ensures clean cache updates without stale data accumulation.
