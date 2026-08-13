/** Poll frequently enough to overlap FPL's deadline-dependent pick publication window. */
export const ENTRY_PICKS_CRON_PATTERN = '*/5 * * * *';

/** Once daily before GW1; every minute in this range once an event is current. */
export const PLAYER_VALUES_CRON_PATTERN = '25-35 9 * * *';

/** Read-only market snapshot cardinality check after the primary capture window. */
export const PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN = '36 9 * * *';

/** Daily current-price reconciliation from persisted Rise/Faller history. */
export const PLAYER_PRICES_REPLAY_CRON_PATTERN = '40 9 * * *';

/** Daily transfer/popularity statistics refresh for the current or preseason next event. */
export const PLAYER_STATS_CRON_PATTERN = '40 9 * * *';
