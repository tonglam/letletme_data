// Cache TTL configurations (in seconds)
export const CacheTTL = {
  METADATA: 30 * 24 * 60 * 60, // 30 days
  DERIVED_DATA: 24 * 60 * 60, // 24 hours
  TEMPORARY: 60 * 60, // 1 hour
} as const;

// Default TTL configurations for different cache types
export const DefaultTTL = {
  EVENT: CacheTTL.DERIVED_DATA, // 24 hours
  PHASE: CacheTTL.DERIVED_DATA,
  TEAM: CacheTTL.DERIVED_DATA,
  STANDING: CacheTTL.TEMPORARY, // 1 hour
  PLAYER: CacheTTL.DERIVED_DATA,
  PLAYER_VALUE: CacheTTL.TEMPORARY,
  PLAYER_STAT: CacheTTL.TEMPORARY,
} as const;

// Cache prefix configurations
export const CachePrefix = {
  PHASE: 'phase',
  EVENT: 'event',
  TEAM: 'team',
  STANDING: 'standing',
  PLAYER: 'player',
  PLAYER_VALUE: 'player-value',
  PLAYER_STAT: 'player-stat',
} as const;
