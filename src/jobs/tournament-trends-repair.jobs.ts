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
  retirePublicTrendsReusedFreshnessWindow,
} from '../services/data-governance.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const TOURNAMENT_TRENDS_REPAIR_SCHEDULE = '*/5 * * * *';

export function isCompleteReusedTournamentTrendRepair(input: {
  repairTargetCount: number;
  succeededCount: number;
  failedCount: number;
  publicationStates: readonly string[];
  expectedCohortCount: number;
  observedCohortCount: number;
  complete: boolean;
}): boolean {
  return (
    input.complete &&
    input.expectedCohortCount > 0 &&
    input.observedCohortCount === input.expectedCohortCount &&
    input.repairTargetCount > 0 &&
    input.succeededCount === input.repairTargetCount &&
    input.failedCount === 0 &&
    input.publicationStates.length === input.repairTargetCount &&
    input.publicationStates.every((state) => state === 'REUSED')
  );
}

async function settleTrendsFreshnessNotApplicable(
  freshnessWindowId: number | undefined,
  reasonCode: string,
  evidence?: Record<string, unknown>,
) {
  if (freshnessWindowId === undefined) return { freshnessEvidenceRecorded: false } as const;
  const recorded = await markFreshnessWindowNotApplicable({
    windowId: freshnessWindowId,
    reasonCode,
    evidence,
  });
  if (!recorded) throw new Error(`Tournament Trends freshness window rejected ${reasonCode}`);
  return { freshnessEvidenceRecorded: true } as const;
}

export async function repairTournamentTrendScopes(input: { freshnessWindowId?: number } = {}) {
  const season = await seasonRepository.findCurrent();
  const currentEvent = await eventRepository.findCurrent(season);
  if (!currentEvent || currentEvent.id < 1 || currentEvent.id > 38) {
    return settleTrendsFreshnessNotApplicable(
      input.freshnessWindowId,
      'PUBLIC_TRENDS_NO_CURRENT_EVENT',
    );
  }
  const [before, repairTournamentIds] = await Promise.all([
    readPublicTrendFreshnessEvidence(season.seasonCode, currentEvent.id),
    findPublicTrendRepairTournamentIds(season.seasonCode),
  ]);
  if (repairTournamentIds.length === 0) {
    if (before.expectedCohortCount > 0) {
      throw new Error('Enabled Public Trends cohorts have no setup-complete repair target');
    }
    return {
      ...before,
      ...(await settleTrendsFreshnessNotApplicable(
        input.freshnessWindowId,
        'PUBLIC_TRENDS_NO_ELIGIBLE_COHORTS',
      )),
    };
  }
  const result = await publishTournamentTrendScopes(season, currentEvent.id, repairTournamentIds);
  const after = await readPublicTrendFreshnessEvidence(season.seasonCode, currentEvent.id);
  const prepublication = {
    prepublishedCohortCount: result.succeeded,
    prepublicationFailedCount: result.failed,
  } as const;
  if (after.expectedCohortCount === 0) {
    return {
      ...after,
      ...(await settleTrendsFreshnessNotApplicable(
        input.freshnessWindowId,
        'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
        prepublication,
      )),
      ...prepublication,
    };
  }
  if (!after.complete || !after.sourceCheckedAt || !after.pgPublishedAt) {
    throw new Error('Tournament Trends publication evidence is incomplete');
  }
  let freshnessEvidenceRecorded = false;
  if (input.freshnessWindowId) {
    const allTargetsReused = isCompleteReusedTournamentTrendRepair({
      repairTargetCount: repairTournamentIds.length,
      succeededCount: result.succeeded,
      failedCount: result.failed,
      publicationStates: result.results.map((publication) => publication.state),
      expectedCohortCount: after.expectedCohortCount,
      observedCohortCount: after.observedCohortCount,
      complete: after.complete,
    });
    if (allTargetsReused) {
      const recorded = await retirePublicTrendsReusedFreshnessWindow({
        windowId: input.freshnessWindowId,
        eventId: currentEvent.id,
        expectedCohortCount: after.expectedCohortCount,
        observedCohortCount: after.observedCohortCount,
        repairTargetCount: repairTournamentIds.length,
        reusedCount: result.results.length,
        failedCount: result.failed,
        catalogRevision: after.catalogRevision,
        producerRevision: after.revision,
      });
      if (!recorded) {
        throw new Error('Tournament Trends reused freshness window is unavailable');
      }
      return { ...after, ...prepublication, freshnessEvidenceRecorded: true };
    }
    const status = await recordFreshnessObservation({
      windowId: input.freshnessWindowId,
      sourceCheckedAt: after.sourceCheckedAt,
      pgPublishedAt: after.pgPublishedAt,
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
        sourceCheckedAt: after.sourceCheckedAt.toISOString(),
        pgPublishedAt: after.pgPublishedAt.toISOString(),
        ...prepublication,
      },
    });
    if (status === null) throw new Error('Tournament Trends freshness window is unavailable');
    freshnessEvidenceRecorded = true;
  }
  return { ...after, ...prepublication, freshnessEvidenceRecorded };
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
