// Manager Live final implementation. Kept behind the compatibility facade.
import { entryEventResultsRepository } from '../../repositories/entry-event-results';
import { contentHash } from '../../utils/content-hash';
import { isCompleteEntryPicks } from '../../domain/entry-picks';
import type { FplSeasonRef } from '../../domain/fpl-season';
import { MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT } from '../../domain/manager-live-refresh';
import {
  isEffectiveLineup,
  type EffectiveLineupRow,
} from '../../domain/event-live-manager-projection';
import { CachedRow, STALE_SECONDS, nowIso, plusSeconds } from './publication-store';

export const nextRefresh = (eventFinished: boolean): string =>
  new Date(Date.now() + (eventFinished ? 60_000 : 30_000)).toISOString();

export const buildFinalEffectiveLineup = (
  eventPicks: unknown,
  automaticSubstitutions: unknown,
): readonly EffectiveLineupRow[] | null => {
  if (!Array.isArray(eventPicks) || eventPicks.length !== 15) return null;
  const picks = eventPicks.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return [];
    const row = candidate as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.element) ||
      (row.element as number) <= 0 ||
      !Number.isSafeInteger(row.position) ||
      (row.position as number) < 1 ||
      (row.position as number) > 15 ||
      !Number.isSafeInteger(row.multiplier) ||
      (row.multiplier as number) < 0 ||
      (row.multiplier as number) > 3 ||
      typeof row.is_captain !== 'boolean' ||
      typeof row.is_vice_captain !== 'boolean'
    ) {
      return [];
    }
    return [
      {
        element: row.element as number,
        position: row.position as number,
        multiplier: row.multiplier as number,
        is_captain: row.is_captain,
        is_vice_captain: row.is_vice_captain,
      },
    ];
  });
  if (
    picks.length !== 15 ||
    new Set(picks.map((pick) => pick.element)).size !== 15 ||
    new Set(picks.map((pick) => pick.position)).size !== 15 ||
    picks.filter((pick) => pick.is_captain).length !== 1 ||
    picks.filter((pick) => pick.is_vice_captain).length !== 1 ||
    picks.some((pick) => pick.is_captain && pick.is_vice_captain)
  ) {
    return null;
  }
  const substitutions = Array.isArray(automaticSubstitutions)
    ? automaticSubstitutions
        .filter((candidate): candidate is Record<string, unknown> => {
          return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
        })
        .map((candidate) => Number(candidate.element_in))
        .filter((elementId) => Number.isSafeInteger(elementId) && elementId > 0)
    : [];
  const autoSubElements = new Set(substitutions);
  const scoringCaptain = picks.find((pick) => pick.multiplier > 1)?.element ?? null;
  const rows = picks.map((pick) => ({
    elementId: pick.element,
    position: pick.position,
    sourceMultiplier: pick.multiplier,
    effectiveMultiplier: pick.multiplier,
    pickActive: pick.multiplier > 0,
    autoSub: autoSubElements.has(pick.element),
    isCaptain: pick.is_captain,
    isViceCaptain: pick.is_vice_captain,
    captainForScoring: pick.element === scoringCaptain,
  }));
  return isEffectiveLineup(rows) ? rows : null;
};

export const finalResultRows = async (
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  freshAfter: Date | null,
  includeEffectiveLineup: boolean,
): Promise<CachedRow[]> => {
  const results = await entryEventResultsRepository.findByEventAndEntryIds(
    season,
    eventId,
    Array.from(new Set(entryIds)),
  );
  const freshAfterMs = freshAfter?.getTime() ?? null;
  return results
    .filter(
      (result) =>
        result.richSyncedAt !== null &&
        isCompleteEntryPicks(result.eventPicks) &&
        Number.isSafeInteger(result.eventPoints) &&
        Number.isSafeInteger(result.eventNetPoints) &&
        Number.isSafeInteger(result.eventTransfersCost) &&
        result.eventTransfersCost >= 0 &&
        result.eventNetPoints === result.eventPoints - result.eventTransfersCost &&
        (freshAfterMs === null || result.richSyncedAt.getTime() >= freshAfterMs),
    )
    .map((result) =>
      (() => {
        const checkedAt = result.richSyncedAt?.toISOString() ?? nowIso();
        const picksRevision = contentHash(result.eventPicks);
        // The source row identity is not the content identity. FPL can amend
        // an already-published result while retaining the same source ID, so
        // every score-bearing field must participate in the revision. Source
        // timestamps are deliberately excluded: a heartbeat-only refresh is
        // not a score change.
        const resultRevision = contentHash({
          entryId: result.entryId,
          eventId: result.eventId,
          sourceResultId: result.sourceResultId,
          eventPoints: result.eventPoints,
          eventNetPoints: result.eventNetPoints,
          overallPoints: result.overallPoints,
          eventTransfers: result.eventTransfers,
          eventTransfersCost: result.eventTransfersCost,
          eventChip: result.eventChip,
          playedCaptainElementId: result.playedCaptainElementId,
          captainPoints: result.captainPoints,
          automaticSubstitutions: result.automaticSubstitutions,
          eventPicks: result.eventPicks,
        });
        const inputRevision = contentHash({
          eventId: result.eventId,
          entryId: result.entryId,
          resultRevision,
          picksRevision,
          dataCheckedAt: freshAfter?.toISOString() ?? null,
        });
        // Keep score identity independent of response shape. A score-only
        // read and a detail read must receive the same revision even though
        // only the latter carries the 15-row lineup payload.
        const completeEffectiveLineup = buildFinalEffectiveLineup(
          result.eventPicks,
          result.automaticSubstitutions,
        );
        const scoreRevision = contentHash({
          inputRevision,
          eventPoints: result.eventPoints,
          netEventPoints: result.eventNetPoints,
          totalPoints: result.overallPoints,
          transferCost: result.eventTransfersCost,
          effectiveLineup: completeEffectiveLineup,
        });
        const effectiveLineup = includeEffectiveLineup ? completeEffectiveLineup : undefined;
        const row: CachedRow = {
          season: season.seasonCode,
          eventId,
          entryId: result.entryId,
          eventPoints: result.eventPoints,
          netEventPoints: result.eventNetPoints,
          totalPoints: result.overallPoints,
          totalScope: 'OVERALL',
          eventRank: result.eventRank,
          overallRank: result.overallRank,
          leagueRank: null,
          source: 'FPL_FINAL_RESULT',
          transferCost: result.eventTransfersCost,
          eventPointSemantics: 'GROSS',
          checkedAt,
          upstreamUpdatedAt: result.richSyncedAt?.toISOString() ?? null,
          staleAt: plusSeconds(checkedAt, STALE_SECONDS),
          calculationMode: 'FINAL_RESULT',
          algorithmVersion: null,
          revision: scoreRevision,
          ...(effectiveLineup ? { effectiveLineup } : {}),
        };
        return {
          ...row,
          provenance: {
            scoreSource: 'FPL_FINAL_RESULT' as const,
            calculationMode: 'FINAL_RESULT' as const,
            algorithmVersion: null,
            inputRevision,
            scoreRevision,
            rankRevision: null,
            livePublicationId: null,
            liveRevision: null,
            liveCheckedAt: null,
            picksRevision,
            picksCheckedAt: checkedAt,
            previousTotalsRevision: null,
            previousTotalsThroughEventId: eventId > 1 ? eventId - 1 : null,
            resultRevision,
            resultCheckedAt: checkedAt,
            dataCheckedAt: freshAfter?.toISOString() ?? null,
            rankSource: null,
            rankCheckedAt: null,
          },
        };
      })(),
    );
};

export const workerProjectionEntryIds = (
  entryIds: readonly number[],
  workerTournamentRefresh: boolean,
): number[] =>
  workerTournamentRefresh
    ? entryIds.slice(0, MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT)
    : [...entryIds];
