import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { publishTournamentTrendScopes } from '../services/tournament-trends-publication.service';
import {
  findPublicTrendRepairTournamentIds,
  readPublicTrendFreshnessEvidence,
} from '../services/trends-catalog.service';
import {
  markFreshnessWindowNotApplicable,
  recordFreshnessObservation,
} from '../services/data-governance.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const TOURNAMENT_TRENDS_REPAIR_SCHEDULE = '*/5 * * * *';

export async function repairTournamentTrendScopes(input: { freshnessWindowId?: number } = {}) {
  const season = await seasonRepository.findCurrent();
  const currentEvent = await eventRepository.findCurrent(season);
  if (!currentEvent || currentEvent.id < 1 || currentEvent.id > 38) {
    if (input.freshnessWindowId) {
      await markFreshnessWindowNotApplicable({
        windowId: input.freshnessWindowId,
        reasonCode: 'PUBLIC_TRENDS_NO_CURRENT_EVENT',
      });
    }
    return;
  }
  const [before, repairTournamentIds] = await Promise.all([
    readPublicTrendFreshnessEvidence(season.seasonCode, currentEvent.id),
    findPublicTrendRepairTournamentIds(season.seasonCode),
  ]);
  if (repairTournamentIds.length === 0) {
    if (before.expectedCohortCount > 0) {
      throw new Error('Enabled Public Trends cohorts have no setup-complete repair target');
    }
    if (input.freshnessWindowId) {
      await markFreshnessWindowNotApplicable({
        windowId: input.freshnessWindowId,
        reasonCode: 'PUBLIC_TRENDS_NO_ELIGIBLE_COHORTS',
      });
    }
    return before;
  }
  const result = await publishTournamentTrendScopes(season, currentEvent.id, repairTournamentIds);
  if (result.failed > 0)
    throw new Error(`Tournament Trends repair failed for ${result.failed} scope(s)`);
  const after = await readPublicTrendFreshnessEvidence(season.seasonCode, currentEvent.id);
  if (after.expectedCohortCount === 0) {
    if (input.freshnessWindowId) {
      await markFreshnessWindowNotApplicable({
        windowId: input.freshnessWindowId,
        reasonCode: 'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
        evidence: { prepublishedCohortCount: result.succeeded },
      });
    }
    return after;
  }
  if (!after.complete) throw new Error('Tournament Trends publication is incomplete');
  let freshnessEvidenceRecorded = false;
  if (input.freshnessWindowId) {
    const status = await recordFreshnessObservation({
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
    if (status === null) throw new Error('Tournament Trends freshness window is unavailable');
    freshnessEvidenceRecorded = true;
  }
  return { ...after, freshnessEvidenceRecorded };
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
