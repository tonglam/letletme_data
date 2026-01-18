# Cache TTL Summary

All cache TTL (Time To Live) configurations in seconds.

## Cache TTL Values (Updated with Long TTL Strategy)

| Cache Type | TTL (seconds) | TTL (human) | Cache Key Pattern | Category |
|------------|---------------|-------------|-------------------|----------|
| **EVENTS** | 604800 | 7 days | `Event:{season}` | Basic/Static |
| **TEAMS** | 2592000 | 30 days | `Team:{season}` | Basic/Static |
| **PHASES** | 2592000 | 30 days | `Phase:{season}` | Basic/Static |
| **PLAYERS** | 86400 | 24 hours | `Player:{season}` | Basic/Static |
| **FIXTURES** | 21600 | 6 hours | `Fixtures:{season}:{eventId}` | Game Data |
| **PLAYER_STATS** | 7200 | 2 hours | `PlayerStat:{season}` | Game Data |
| **player_values** | 7200 | 2 hours | `PlayerValue:{changeDate}` | Game Data |
| **EVENT_LIVE** | 120 | 2 minutes | `EventLive:{season}:{eventId}` | Live Match Data |
| **EVENT_LIVE_EXPLAIN** | 120 | 2 minutes | `EventLiveExplain:{season}:{eventId}` | Live Match Data |
| **EVENT_LIVE_SUMMARY** | 86400 | 24 hours | `EventLiveSummary:{season}:{eventId}` | Aggregated Data |
| **EVENT_OVERALL_RESULT** | 86400 | 24 hours | `EventOverallResult:{season}` | Aggregated Data |
| **EVENT_STANDINGS** | 86400 | 24 hours | `EventStandings:{season}` | Aggregated Data |
| **LIVE_DATA** | 60 | 1 minute | N/A | Live Match Data |

## Default Cache Config

- **DEFAULT_CACHE_CONFIG.ttl**: 300 seconds (5 minutes)
  - Used by generic cache operations when no specific TTL is provided

## TTL Strategy Rationale

### Why Long TTL?
Since **read operations don't update the cache** (only sync operations do), using long TTL values prevents cache misses and ensures:
- Consistent performance (no unexpected cache misses)
- Reduced database load (cache stays populated)
- Predictable behavior

### TTL Categories

1. **Basic/Static Data (7-30 days)**:
   - `EVENTS` (7 days) - Event schedule is stable
   - `TEAMS` (30 days) - Teams rarely change mid-season
   - `PHASES` (30 days) - Season phases are fixed
   - `PLAYERS` (24 hours) - Player data updates daily

2. **Game Data (2-6 hours)**:
   - `FIXTURES` (6 hours) - Updates during matchdays but stable between matches
   - `PLAYER_STATS` (2 hours) - Stats update after matches
   - `player_values` (2 hours) - Price changes happen slowly

3. **Live Match Data (1-2 minutes)**:
   - `EVENT_LIVE` (2 minutes) - Real-time match data
   - `EVENT_LIVE_EXPLAIN` (2 minutes) - Real-time explain data
   - `LIVE_DATA` (1 minute) - General live data
   - These **must** expire quickly to reflect live match updates

4. **Aggregated/Historical Data (24 hours)**:
   - `EVENT_LIVE_SUMMARY` (24 hours) - Season-to-date aggregations
   - `EVENT_OVERALL_RESULT` (24 hours) - Overall results
   - `EVENT_STANDINGS` (24 hours) - League standings

### Cache Refresh Strategy
- Caches are updated by scheduled sync jobs (not by read operations)
- Long TTL ensures cache remains available between syncs
- If cache expires, reads fall back to database (performance penalty)
