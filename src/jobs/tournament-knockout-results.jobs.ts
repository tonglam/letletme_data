import type { Elysia } from 'elysia';

import { logInfo } from '../utils/logger';

/**
 * Tournament Knockout Results Sync
 *
 * NOTE: This is now part of the tournament cascade.
 * Triggered automatically after tournament-event-results completes.
 * No separate cron needed.
 */

export async function runTournamentKnockoutResultsSync() {
  // This is now handled by cascade from tournament-event-results
  // Keeping function for backward compatibility with manual triggers
  logInfo('Tournament knockout is now part of cascade');
}

export function registerTournamentKnockoutResultsJobs(app: Elysia) {
  // Now part of cascade, no cron needed
  // Return app unchanged for backward compatibility
  return app;
}
