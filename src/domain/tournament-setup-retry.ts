export const TOURNAMENT_SETUP_MAX_ATTEMPTS = 3;
export const TOURNAMENT_SETUP_BACKOFF_DELAY_MS = 60_000;

export function getTournamentSetupRetryDelayMs(attempt: number): number {
  return TOURNAMENT_SETUP_BACKOFF_DELAY_MS * 2 ** Math.max(0, Math.trunc(attempt) - 1);
}
