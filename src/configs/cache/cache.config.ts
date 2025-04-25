export const CacheTTL = {
  METADATA: 30 * 24 * 60 * 60, // 30 days
  DERIVED_DATA: 24 * 60 * 60, // 24 hours
  TEMPORARY: 60 * 60, // 1 hour
  DAILY: 24 * 60 * 60, // 1 day
  WEEKLY: 7 * 24 * 60 * 60, // 7 days
} as const;

export const DefaultTTL = {
  EVENT: CacheTTL.DERIVED_DATA,
  EVENT_CURRENT: CacheTTL.WEEKLY, // TTL for the specific current event key
  PHASE: CacheTTL.DERIVED_DATA,
  TEAM: CacheTTL.DERIVED_DATA,
  STANDING: CacheTTL.TEMPORARY,
  PLAYER: CacheTTL.DERIVED_DATA,
  PLAYER_VALUE: CacheTTL.DAILY,
  PLAYER_STAT: CacheTTL.TEMPORARY,
} as const;

export const CachePrefix = {
  EVENT: 'event',
  PHASE: 'phase',
  TEAM: 'team',
  PLAYER: 'player',
  PLAYER_VALUE: 'player-value',
  PLAYER_STAT: 'player-stat',
  FIXTURE: 'fixture',
} as const;
