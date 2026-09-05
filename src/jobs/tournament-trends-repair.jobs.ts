import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { publishTournamentTrendScopes } from '../services/tournament-trends-publication.service';
import { readPublicTrendFreshnessEvidence } from '../services/trends-catalog.service';
import { recordFreshnessObservation } from '../services/data-governance.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const TOURNAMENT_TRENDS_REPAIR_SCHEDULE = '*/5 * * * *';

export async function repairTournamentTrendScopes(input: { freshnessWindowId?: number } = {}) {
  const season = await seasonRepository.findCurrent();
  const currentEvent = await eventRepository.findCurrent(season);
  if (!currentEvent || currentEvent.id < 1 || currentEvent.id > 38) return;
  const before = await readPublicTrendFreshnessEvidence(season.seasonCode, currentEvent.id);
  if (before.expectedCohortCount === 0) return;
  const result = await publishTournamentTrendScopes(
    season,
    currentEvent.id,
    before.cohorts.map((cohort) => cohort.tournamentId),
  );
  if (result.failed > 0)
    throw new Error(`Tournament Trends repair failed for ${result.failed} scope(s)`);
  const after = await readPublicTrendFreshnessEvidence(season.seasonCode, currentEvent.id);
  if (!after.complete) throw new Error('Tournament Trends publication is incomplete');
  if (input.freshnessWindowId) {
    await recordFreshnessObservation({
      windowId: input.freshnessWindowId,
      sourceCheckedAt: after.sourceCheckedAt ?? new Date(),
      pgPublishedAt: after.pgPublishedAt ?? undefined,
      producerRevision: after.revision,
      expectedCount: after.expectedCohortCount,
      observedCount: after.observedCohortCount,
      completenessStatus: 'COMPLETE',
      evidence: {
        catalogRevision: after.catalogRevision,
        expectedCohortCount: after.expectedCohortCount,
        observedCohortCount: after.observedCohortCount,
        expectedEntryCount: after.expectedEntryCount,
        observedRowCount: after.observedRowCount,
        pgPublishedAt: after.pgPublishedAt?.toISOString() ?? null,
      },
    });
  }
  return after;
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
