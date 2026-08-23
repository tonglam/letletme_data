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

/** One-minute coordinator; eligible non-live repair states back off to five minutes. */
export const PLAYER_STATS_ACTIVE_CRON_PATTERN = '* * * * *';

export type PlayerStatsActiveCadence = 'one-minute' | 'five-minute' | null;

/**
 * Bootstrap player totals can change while a match is active, while FPL is
 * settling a day, between fixture days, or before data_checked finalization.
 * Pre-deadline, picks-wait/probe, and finalized phases use the daily,
 * transition, and explicit final-repair paths instead of polling a static
 * full-table replacement every five minutes.
 */
export function resolvePlayerStatsActiveCadence(
  lifecycleState: string,
  now: Date,
): PlayerStatsActiveCadence {
  if (lifecycleState === 'LIVE_ACTIVE' || lifecycleState === 'DAY_SETTLING') {
    return 'one-minute';
  }
  if (
    lifecycleState === 'PICKS_SYNC' ||
    lifecycleState === 'BETWEEN_FIXTURES' ||
    lifecycleState === 'GW_REVIEW'
  ) {
    return now.getUTCMinutes() % 5 === 0 ? 'five-minute' : null;
  }
  return null;
}
