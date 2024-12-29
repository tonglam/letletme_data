/**
 * Cache time-to-live (TTL) configurations in seconds
 * @const {Readonly<{METADATA: number, DERIVED_DATA: number, TEMPORARY: number}>}
 */
export const CacheTTL = {
  METADATA: 30 * 24 * 60 * 60, // 30 days
  DERIVED_DATA: 24 * 60 * 60, // 24 hours
  TEMPORARY: 60 * 60, // 1 hour
} as const;

/**
 * Default TTL configurations for different data types
 * @const {Readonly<{EVENT: number, PHASE: number, TEAM: number, STANDING: number, PLAYER: number, PLAYER_VALUE: number, PLAYER_STAT: number}>}
 */
export const DefaultTTL = {
  EVENT: CacheTTL.DERIVED_DATA,
  PHASE: CacheTTL.DERIVED_DATA,
  TEAM: CacheTTL.DERIVED_DATA,
  STANDING: CacheTTL.TEMPORARY,
  PLAYER: CacheTTL.DERIVED_DATA,
  PLAYER_VALUE: CacheTTL.TEMPORARY,
  PLAYER_STAT: CacheTTL.TEMPORARY,
} as const;

/**
 * Cache key prefix configurations for different data types
 * @const {Readonly<{PHASE: string, EVENT: string, TEAM: string, STANDING: string, PLAYER: string, PLAYER_VALUE: string, PLAYER_STAT: string}>}
 */
export const CachePrefix = {
  PHASE: 'phase',
  EVENT: 'event',
  TEAM: 'team',
  STANDING: 'standing',
  PLAYER: 'player',
  PLAYER_VALUE: 'player-value',
  PLAYER_STAT: 'player-stat',
} as const;
