import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { publishTournamentTrendScopes } from '../services/tournament-trends-publication.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const TOURNAMENT_TRENDS_REPAIR_SCHEDULE = '*/5 * * * *';

export async function repairTournamentTrendScopes(): Promise<void> {
  const season = await seasonRepository.findCurrent();
  const currentEvent = await eventRepository.findCurrent(season);
  if (!currentEvent || currentEvent.id < 1 || currentEvent.id > 38) return;
  const tournaments = await tournamentInfoRepository.findActive(season);
  const result = await publishTournamentTrendScopes(
    season,
    currentEvent.id,
    tournaments.map((tournament) => tournament.id),
  );
  if (result.failed > 0)
    throw new Error(`Tournament Trends repair failed for ${result.failed} scope(s)`);
}

export function registerTournamentTrendsRepairJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-trends-repair',
      pattern: TOURNAMENT_TRENDS_REPAIR_SCHEDULE,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('tournament-trends-repair', async () => {
            if (isStandaloneSchedulerEnabled()) return;
            await repairTournamentTrendScopes();
          });
        } catch {
          // executeTrackedCron records the bounded failure.
        }
      },
    }),
  );
}
