import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import type { FplSeasonRef } from '../domain/fpl-season';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { publishTournamentTrendScopes } from '../services/tournament-trends-publication.service';
import {
  findPublicTrendRepairTournamentIds,
  readPublicTrendFreshnessEvidence,
} from '../services/trends-catalog.service';
import {
  recordFreshnessObservation,
  retirePublicTrendsIneligibleFreshnessWindow,
  retirePublicTrendsReusedFreshnessWindow,
} from '../services/data-governance.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const TOURNAMENT_TRENDS_REPAIR_SCHEDULE = '*/5 * * * *';

export function isCompleteReusedTournamentTrendRepair(input: {
  enabledTournamentIds: readonly number[];
  publicationResults: readonly Readonly<{ tournamentId: number; state: string }>[];
  expectedCohortCount: number;
  observedCohortCount: number;
  complete: boolean;
}): boolean {
  const enabledTournamentIds = [...new Set(input.enabledTournamentIds)];
  const resultByTournamentId = new Map(
    input.publicationResults.map((result) => [result.tournamentId, result.state] as const),
  );
  return (
    input.complete &&
    input.expectedCohortCount > 0 &&
    input.observedCohortCount === input.expectedCohortCount &&
    enabledTournamentIds.length === input.expectedCohortCount &&
    enabledTournamentIds.every(
      (tournamentId) => resultByTournamentId.get(tournamentId) === 'REUSED',
    )
  );
}

async function settleTrendsFreshnessNotApplicable(
  freshnessWindowId: number | undefined,
  reasonCode:
    | 'PUBLIC_TRENDS_NO_CURRENT_EVENT'
    | 'PUBLIC_TRENDS_NO_ELIGIBLE_COHORTS'
    | 'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
  eventId?: number,
  evidence?: Record<string, unknown>,
) {
  if (freshnessWindowId === undefined) return { freshnessEvidenceRecorded: false } as const;
  const recorded = await retirePublicTrendsIneligibleFreshnessWindow({
    windowId: freshnessWindowId,
    reasonCode,
    ...(eventId === undefined ? {} : { eventId }),
    evidence,
  });
  if (!recorded) throw new Error(`Tournament Trends freshness window rejected ${reasonCode}`);
  return { freshnessEvidenceRecorded: true } as const;
}

export function resolveTournamentTrendRepairEventId(
  scopedEventId: number | null | undefined,
  currentEventId: number | null,
): number | null {
  if (scopedEventId === null) {
    if (currentEventId !== null) {
      throw new Error(
        `Tournament Trends no-current-event scope changed to event ${currentEventId}`,
      );
    }
    return null;
  }
  const eventId = scopedEventId ?? currentEventId;
  if (eventId === null) return null;
  if (!Number.isSafeInteger(eventId) || eventId < 1 || eventId > 38) {
    throw new Error(`Tournament Trends event scope is invalid: ${eventId}`);
  }
  return eventId;
}

export async function repairTournamentTrendScopes(
  input: {
    freshnessWindowId?: number;
    /** Explicit job scope; omitted only by the legacy in-process cron. */
    scope?: Readonly<{ season: FplSeasonRef; eventId: number | null }>;
  } = {},
) {
  const season = input.scope?.season ?? (await seasonRepository.findCurrent());
  const currentEvent = await eventRepository.findCurrent(season);
  const targetEventId = resolveTournamentTrendRepairEventId(
    input.scope?.eventId,
    currentEvent?.id ?? null,
  );
  if (targetEventId === null) {
    return settleTrendsFreshnessNotApplicable(
      input.freshnessWindowId,
      'PUBLIC_TRENDS_NO_CURRENT_EVENT',
    );
  }
  const targetEvent =
    currentEvent?.id === targetEventId
      ? currentEvent
      : await eventRepository.findById(season, targetEventId);
  if (!targetEvent) {
    throw new Error(`Tournament Trends event ${targetEventId} does not exist in the job season`);
  }
  const [before, repairTournamentIds] = await Promise.all([
    readPublicTrendFreshnessEvidence(season.seasonCode, targetEvent.id),
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
        targetEvent.id,
      )),
    };
  }
  const result = await publishTournamentTrendScopes(season, targetEvent.id, repairTournamentIds);
  const after = await readPublicTrendFreshnessEvidence(season.seasonCode, targetEvent.id);
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
        targetEvent.id,
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
    const enabledTournamentIds = after.cohorts.map((cohort) => cohort.tournamentId);
    const enabledTargetsReused = isCompleteReusedTournamentTrendRepair({
      enabledTournamentIds,
      publicationResults: result.results,
      expectedCohortCount: after.expectedCohortCount,
      observedCohortCount: after.observedCohortCount,
      complete: after.complete,
    });
    if (enabledTargetsReused) {
      const recorded = await retirePublicTrendsReusedFreshnessWindow({
        windowId: input.freshnessWindowId,
        eventId: targetEvent.id,
        expectedCohortCount: after.expectedCohortCount,
        observedCohortCount: after.observedCohortCount,
        enabledTournamentIds,
        enabledReusedCount: enabledTournamentIds.length,
        repairTargetCount: repairTournamentIds.length,
        succeededCount: result.succeeded,
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
