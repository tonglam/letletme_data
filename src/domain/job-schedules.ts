/** Poll frequently enough to overlap FPL's deadline-dependent pick publication window. */
export const ENTRY_PICKS_CRON_PATTERN = '*/5 * * * *';

/** Coalesce mutable Live Points score checkpoints to protect PostgreSQL during matches. */
export const LIVE_SCORE_CHECKPOINT_INTERVAL_MS = 10 * 60_000;

/** Once daily before GW1; every minute in this range once an event is current. */
export const PLAYER_VALUES_CRON_PATTERN = '55-59 6 * * *';
/** The five-minute rollover that completes the 06:55-07:05 UTC+8 window. */
export const PLAYER_VALUES_CRON_ROLLOVER_PATTERN = '0-5 7 * * *';

/** Read-only market snapshot cardinality check after the primary capture window. */
export const PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN = '6 7 * * *';

/** Daily current-price reconciliation from persisted Rise/Faller history. */
export const PLAYER_PRICES_REPLAY_CRON_PATTERN = '10 7 * * *';

/** Daily transfer/popularity statistics refresh for the current or preseason next event. */
export const PLAYER_STATS_CRON_PATTERN = '40 9 * * *';
