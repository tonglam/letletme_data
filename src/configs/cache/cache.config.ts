export const CacheTTL = {
  METADATA: 30 * 24 * 60 * 60, // 30 days
  DERIVED_DATA: 24 * 60 * 60, // 24 hours
  TEMPORARY: 60 * 60, // 1 hour
  DAILY: 24 * 60 * 60, // 1 day
  WEEKLY: 7 * 24 * 60 * 60, // 7 days
} as const;

export const DefaultTTL = {
  EVENT: CacheTTL.DERIVED_DATA,
  EVENT_CURRENT: CacheTTL.WEEKLY,
  PHASE: CacheTTL.DERIVED_DATA,
  TEAM: CacheTTL.DERIVED_DATA,
  PLAYER: CacheTTL.DERIVED_DATA,
  PLAYER_VALUE: CacheTTL.DAILY,
  PLAYER_STAT: CacheTTL.DERIVED_DATA,
  FIXTURE: CacheTTL.DERIVED_DATA,
  LIVE: CacheTTL.WEEKLY,
  OVERALL_RESULT: CacheTTL.DERIVED_DATA,
} as const;

export const CachePrefix = {
  EVENT: 'event',
  PHASE: 'phase',
  TEAM: 'team',
  PLAYER: 'player',
  PLAYER_VALUE: 'player-value',
  PLAYER_STAT: 'player-stat',
  FIXTURE: 'fixture',
  LIVE: 'live',
  OVERALL_RESULT: 'overall-result',
} as const;
