/**
 * Queue evidence retention.  A completed/failed count of zero is not a
 * success signal, so keep bounded history long enough for an incident audit.
 */
export const BULL_COMPLETED_RETENTION = { age: 86_400, count: 500 } as const;
export const BULL_FAILED_RETENTION = { age: 7 * 86_400, count: 500 } as const;
