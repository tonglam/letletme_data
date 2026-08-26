import {
  readLiveSnapshotCache,
  readLiveSnapshotCacheByReference,
  type LiveSnapshotCacheContents,
} from '../cache/live-snapshot-cache';
import type { EventLiveManagerScore } from '../domain/event-live-manager-score';
import {
  EVENT_LIVE_OFFICIAL_MULTIPLIERS_ALGORITHM_VERSION,
  EVENT_LIVE_PROJECTION_ALGORITHM_VERSION,
  isEffectiveLineup,
  projectOfficialCurrentMultiplierScore,
  projectEventLiveManagerScore,
  type EffectiveLineupRow,
} from '../domain/event-live-manager-projection';
import type { FplSeasonRef } from '../domain/fpl-season';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { entryInfoRepository } from '../repositories/entry-infos';
import {
  persistManagerScoreMaterializations,
  readManagerScoreMaterializationsByInputRevision,
  type ManagerScoreMaterializedRow,
} from '../repositories/manager-score-materializations';
import { contentHash } from '../utils/content-hash';

export type RevisionedEventLiveManagerScore = EventLiveManagerScore & {
  totalPoints: number | null;
  revision: string;
  effectiveLineup?: readonly EffectiveLineupRow[];
  inputRevision?: string;
  picksRevision?: string;
  previousTotalsRevision?: string;
};

export type EventLiveManagerScoreMode = 'OFFICIAL_CURRENT_MULTIPLIERS' | 'PROJECTED_AUTOSUBS';

export type EventLiveManagerScoreBatch = {
  season: string;
  eventId: number;
  state: 'scheduled' | 'live' | 'settled';
  /** The immutable fpl:live manifest revision used by every score in this batch. */
  liveRevision: string;
  revision: string;
  publicationId: string;
  checkedAt: string;
  sourceCheckedAt: string;
  calculationMode: EventLiveManagerScoreMode;
  algorithmVersion: string;
  scores: ReadonlyMap<number, RevisionedEventLiveManagerScore>;
};

export const EVENT_LIVE_PICKS_MAX_AGE_MS = 15 * 60_000;
// The player-live publication is the real-time score authority. A heartbeat
// older than 90 seconds is no longer a real-time observation, even though the
// picks source is allowed its separate 15-minute freshness window above.
export const EVENT_LIVE_HEARTBEAT_MAX_AGE_MS = 90_000;

export function hasCompleteAggregateCoverage(
  row: { eventCount?: number; firstEventId?: number; lastEventId?: number },
  startEventId: number,
  endEventId: number,
): boolean {
  return (
    endEventId >= startEventId &&
    row.eventCount === endEventId - startEventId + 1 &&
    row.firstEventId === startEventId &&
    row.lastEventId === endEventId
  );
}

export function eventLivePicksAreFresh(
  picksCheckedAt: string,
  liveCheckedAt: string,
  maxAgeMs = EVENT_LIVE_PICKS_MAX_AGE_MS,
): boolean {
  const picksTimestamp = Date.parse(picksCheckedAt);
  const liveTimestamp = Date.parse(liveCheckedAt);
  return (
    Number.isFinite(picksTimestamp) &&
    Number.isFinite(liveTimestamp) &&
    picksTimestamp <= liveTimestamp &&
    liveTimestamp - picksTimestamp <= maxAgeMs
  );
}

export function eventLiveHeartbeatIsFresh(
  liveCheckedAt: string,
  nowMs = Date.now(),
  maxAgeMs = EVENT_LIVE_HEARTBEAT_MAX_AGE_MS,
): boolean {
  const liveTimestamp = Date.parse(liveCheckedAt);
  const ageMs = nowMs - liveTimestamp;
  return Number.isFinite(liveTimestamp) && ageMs >= 0 && ageMs <= maxAgeMs;
}

export function eventLiveAuthorityCheckedAt(snapshot: LiveSnapshotCacheContents): string {
  return snapshot.manifest.lastSuccessfulFetchAt ?? snapshot.manifest.sourceCheckedAt;
}

/**
 * Load the one active official player-live publication used by every
 * provisional manager-score projection. Consumers must not independently
 * combine mutable picks with older database player totals.
 */
export async function loadFreshEventLiveAuthoritySnapshot(
  season: FplSeasonRef,
  eventId: number,
  reference?: { publicationId: string; revision: number | string },
  nowMs = Date.now(),
): Promise<LiveSnapshotCacheContents | null> {
  const snapshot = reference
    ? await readLiveSnapshotCacheByReference(season.seasonCode, eventId, reference)
    : await readLiveSnapshotCache(season.seasonCode, eventId);
  if (!snapshot || snapshot.eventId !== eventId || snapshot.season !== season.seasonCode) {
    return null;
  }
  if (!eventLiveHeartbeatIsFresh(eventLiveAuthorityCheckedAt(snapshot), nowMs)) return null;

  const elementIds = new Set<number>();
  for (const row of snapshot.eventLives) {
    if (
      row.eventId !== eventId ||
      !Number.isSafeInteger(row.elementId) ||
      row.elementId <= 0 ||
      !Number.isSafeInteger(row.totalPoints) ||
      elementIds.has(row.elementId)
    ) {
      return null;
    }
    elementIds.add(row.elementId);
  }
  return snapshot;
}

export function buildScoreInputRevision(input: {
  algorithmVersion: string;
  authorityRevision: string;
  entryId: number;
  picks: readonly {
    position: number;
    elementId: number;
    elementType?: number;
    teamId?: number | null;
    multiplier: number;
    isCaptain: boolean;
    isViceCaptain: boolean;
    transfersCost: number | null;
    sourceUpdatedAt: Date;
    activeChip?: string | null;
  }[];
  entryStartedEvent?: number | null;
  previousTotal: number | null;
  previousTotalsThroughEventId?: number | null;
  previousResultEvidence?: readonly {
    entryId: number;
    eventId: number;
    sourceResultId: number | null;
    eventNetPoints: number | null;
    richSyncedAt: Date | null;
    updatedAt: Date;
  }[];
}): { inputRevision: string; picksRevision: string; previousTotalsRevision: string } {
  const canonicalPicks = [...input.picks].sort(
    (left, right) => left.position - right.position || left.elementId - right.elementId,
  );
  const picksRevision = contentHash(
    canonicalPicks.map((pick) => ({
      position: pick.position,
      elementId: pick.elementId,
      elementType: pick.elementType ?? null,
      teamId: pick.teamId ?? null,
      multiplier: pick.multiplier,
      isCaptain: pick.isCaptain,
      isViceCaptain: pick.isViceCaptain,
      transfersCost: pick.transfersCost,
      activeChip: pick.activeChip ?? null,
    })),
  );
  const previousTotalsRevision = contentHash({
    throughEventId: input.previousTotalsThroughEventId ?? null,
    totalNetPoints: input.previousTotal,
    results: (input.previousResultEvidence ?? [])
      .map((result) => ({
        entryId: result.entryId,
        eventId: result.eventId,
        sourceResultId: result.sourceResultId,
        eventNetPoints: result.eventNetPoints,
      }))
      .sort((left, right) => left.eventId - right.eventId || left.entryId - right.entryId),
  });
  return {
    inputRevision: contentHash({
      algorithmVersion: input.algorithmVersion,
      authorityRevision: input.authorityRevision,
      entryId: input.entryId,
      entryStartedEvent: input.entryStartedEvent ?? null,
      picksRevision,
      previousTotalsRevision,
    }),
    picksRevision,
    previousTotalsRevision,
  };
}

const currentPicksCheckedAt = (picks: readonly { sourceUpdatedAt: Date }[]): string | null => {
  if (picks.length === 0) return null;
  const timestamps = new Set(picks.map((pick) => pick.sourceUpdatedAt.getTime()));
  if (timestamps.size !== 1 || !Number.isFinite([...timestamps][0])) return null;
  return new Date([...timestamps][0]!).toISOString();
};

const materializedScoreForCurrentInput = (input: {
  row: ManagerScoreMaterializedRow;
  snapshot: LiveSnapshotCacheContents;
  checkedAt: string;
  calculationMode: 'PROJECTED_AUTOSUBS';
  inputRevision: string;
  picksRevision: string;
  previousTotalsRevision: string;
  previousTotal: number | null;
  picksCheckedAt: string;
  includeEffectiveLineup: boolean;
}): RevisionedEventLiveManagerScore | null => {
  const { row } = input;
  if (
    row.entryId <= 0 ||
    row.inputRevision !== input.inputRevision ||
    row.calculationMode !== input.calculationMode ||
    row.scoreSource !== 'FPL_EVENT_LIVE' ||
    row.livePublicationId !== input.snapshot.manifest.publicationId ||
    row.liveRevision === null ||
    String(row.liveRevision) !== String(input.snapshot.manifest.revision) ||
    row.algorithmVersion !== EVENT_LIVE_PROJECTION_ALGORITHM_VERSION ||
    row.picksRevision !== input.picksRevision ||
    row.previousTotalsRevision !== input.previousTotalsRevision ||
    row.eventPoints === null ||
    row.netEventPoints === null ||
    row.transferCost === null ||
    row.netEventPoints !== row.eventPoints - row.transferCost ||
    (input.previousTotal === null
      ? row.totalPoints !== null
      : row.totalPoints !== input.previousTotal + row.netEventPoints) ||
    !eventLivePicksAreFresh(input.picksCheckedAt, input.checkedAt)
  ) {
    return null;
  }
  const effectiveLineup = isEffectiveLineup(row.effectiveLineup) ? row.effectiveLineup : undefined;
  if (!effectiveLineup) return null;
  const expectedScoreRevision = contentHash({
    inputRevision: row.inputRevision,
    eventPoints: row.eventPoints,
    netEventPoints: row.netEventPoints,
    totalPoints: row.totalPoints,
    effectiveLineup,
  });
  if (row.scoreRevision !== expectedScoreRevision) return null;
  return {
    entryId: row.entryId,
    eventPoints: row.eventPoints,
    netEventPoints: row.netEventPoints,
    transferCost: row.transferCost,
    picksCheckedAt: input.picksCheckedAt,
    totalPoints: row.totalPoints,
    revision: row.scoreRevision,
    inputRevision: row.inputRevision,
    picksRevision: row.picksRevision,
    previousTotalsRevision: row.previousTotalsRevision,
    ...(input.includeEffectiveLineup && effectiveLineup ? { effectiveLineup } : {}),
  };
};

async function loadEventLiveManagerScoreBatch(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  options: {
    includeEffectiveLineup?: boolean;
    liveRef?: { publicationId: string; revision: number | string };
    requestedCalculationMode?: EventLiveManagerScoreMode;
  } = {},
): Promise<EventLiveManagerScoreBatch | null> {
  const uniqueEntryIds = Array.from(new Set(entryIds));
  if (uniqueEntryIds.length === 0) return null;

  const calculationMode: EventLiveManagerScoreMode =
    options.requestedCalculationMode ?? 'PROJECTED_AUTOSUBS';
  const algorithmVersion =
    calculationMode === 'PROJECTED_AUTOSUBS'
      ? EVENT_LIVE_PROJECTION_ALGORITHM_VERSION
      : EVENT_LIVE_OFFICIAL_MULTIPLIERS_ALGORITHM_VERSION;
  const snapshot = await loadFreshEventLiveAuthoritySnapshot(season, eventId, options.liveRef);
  if (!snapshot) return null;

  const liveByElement = new Map(snapshot.eventLives.map((row) => [row.elementId, row] as const));

  const checkedAt = eventLiveAuthorityCheckedAt(snapshot);

  const [pickRows, previousTotals, previousResultEvidence, entryInfos] = await Promise.all([
    entryEventPicksRepository.findScoringPicksByEventAndEntryIds(season, eventId, uniqueEntryIds),
    eventId === 1
      ? Promise.resolve([])
      : entryEventResultsRepository.aggregateTotalsByEntry(season, uniqueEntryIds, 1, eventId - 1, {
          finalizedOnly: true,
        }),
    eventId === 1
      ? Promise.resolve([])
      : entryEventResultsRepository.findRevisionEvidenceByEntry(
          season,
          uniqueEntryIds,
          1,
          eventId - 1,
          { finalizedOnly: true },
        ),
    entryInfoRepository.findByIds(season, uniqueEntryIds),
  ]);
  const picksByEntry = new Map<number, typeof pickRows>();
  for (const pick of pickRows) {
    const rows = picksByEntry.get(pick.entryId) ?? [];
    rows.push(pick);
    picksByEntry.set(pick.entryId, rows);
  }
  const entryStartedEventById = new Map(
    entryInfos.map((entry) => [entry.id, entry.startedEvent] as const),
  );
  const previousTotalsByEntry = new Map(previousTotals.map((row) => [row.entryId, row] as const));
  const previousTotalByEntry = new Map<number, number>();
  if (eventId > 1) {
    const previousEndEventId = eventId - 1;
    for (const entryId of uniqueEntryIds) {
      const startedEvent = entryStartedEventById.get(entryId);
      const firstScoringEvent = Math.max(1, startedEvent ?? 1);
      if (firstScoringEvent > previousEndEventId) {
        previousTotalByEntry.set(entryId, 0);
        continue;
      }
      const aggregate = previousTotalsByEntry.get(entryId);
      if (
        aggregate &&
        (hasCompleteAggregateCoverage(aggregate, 1, previousEndEventId) ||
          hasCompleteAggregateCoverage(aggregate, firstScoringEvent, previousEndEventId))
      ) {
        previousTotalByEntry.set(entryId, aggregate.totalNetPoints);
      }
    }
  }
  const previousResultEvidenceByEntry = new Map<number, typeof previousResultEvidence>();
  for (const result of previousResultEvidence) {
    const startedEvent = entryStartedEventById.get(result.entryId);
    const firstScoringEvent = Math.max(1, startedEvent ?? 1);
    if (result.eventId < firstScoringEvent) continue;
    const rows = previousResultEvidenceByEntry.get(result.entryId) ?? [];
    rows.push(result);
    previousResultEvidenceByEntry.set(result.entryId, rows);
  }

  const authorityRevision = `fpl:live:${snapshot.manifest.publicationId}:${snapshot.manifest.revision}`;
  const inputRevisionByEntry = new Map<
    number,
    { inputRevision: string; picksRevision: string; previousTotalsRevision: string }
  >();
  const picksCheckedAtByEntry = new Map<number, string>();
  for (const entryId of uniqueEntryIds) {
    const picks = picksByEntry.get(entryId) ?? [];
    const previousTotal = eventId === 1 ? 0 : (previousTotalByEntry.get(entryId) ?? null);
    inputRevisionByEntry.set(
      entryId,
      buildScoreInputRevision({
        algorithmVersion,
        authorityRevision,
        entryId,
        entryStartedEvent: entryStartedEventById.get(entryId) ?? null,
        picks,
        previousTotal,
        previousTotalsThroughEventId: eventId > 1 ? eventId - 1 : null,
        previousResultEvidence: previousResultEvidenceByEntry.get(entryId) ?? [],
      }),
    );
    const picksCheckedAt = currentPicksCheckedAt(picks);
    if (picksCheckedAt) picksCheckedAtByEntry.set(entryId, picksCheckedAt);
  }

  const materializedByEntry = new Map<number, ManagerScoreMaterializedRow>();
  const materializations =
    calculationMode === 'PROJECTED_AUTOSUBS'
      ? await readManagerScoreMaterializationsByInputRevision(
          season,
          eventId,
          uniqueEntryIds.flatMap((entryId) => {
            const inputRevision = inputRevisionByEntry.get(entryId)?.inputRevision;
            return inputRevision ? [{ entryId, inputRevision }] : [];
          }),
          'PROJECTED_AUTOSUBS',
        )
      : [];
  for (const row of materializations) materializedByEntry.set(row.entryId, row);

  const scores = new Map<number, RevisionedEventLiveManagerScore>();
  // Keep the projected lineup available to the materialization writer even
  // when the caller requested a score-only response. The public row should
  // not pay the payload/serialization cost of a 15-player lineup unless it
  // explicitly opts in, while persistence always records the complete
  // scoring evidence.
  const projectedLineupByEntry = new Map<number, readonly EffectiveLineupRow[]>();
  for (const entryId of uniqueEntryIds) {
    const picks = picksByEntry.get(entryId) ?? [];
    const inputRevisionData = inputRevisionByEntry.get(entryId);
    const picksCheckedAt = picksCheckedAtByEntry.get(entryId);
    const materialized = materializedByEntry.get(entryId);
    const previousTotal = eventId === 1 ? 0 : (previousTotalByEntry.get(entryId) ?? null);
    if (
      calculationMode === 'PROJECTED_AUTOSUBS' &&
      inputRevisionData &&
      picksCheckedAt &&
      materialized
    ) {
      const cachedScore = materializedScoreForCurrentInput({
        row: materialized,
        snapshot,
        checkedAt,
        calculationMode,
        inputRevision: inputRevisionData.inputRevision,
        picksRevision: inputRevisionData.picksRevision,
        previousTotalsRevision: inputRevisionData.previousTotalsRevision,
        previousTotal,
        picksCheckedAt,
        includeEffectiveLineup: options.includeEffectiveLineup === true,
      });
      if (cachedScore) {
        if (isEffectiveLineup(materialized.effectiveLineup)) {
          projectedLineupByEntry.set(entryId, materialized.effectiveLineup);
        }
        scores.set(entryId, cachedScore);
        continue;
      }
    }
    const projectedScore =
      calculationMode === 'PROJECTED_AUTOSUBS'
        ? projectEventLiveManagerScore({
            entryId,
            picks,
            liveByElement,
            fixtures: snapshot.fixtures,
          })
        : projectOfficialCurrentMultiplierScore({ entryId, picks, liveByElement });
    const score = projectedScore;
    if (!score) continue;
    if (!eventLivePicksAreFresh(score.picksCheckedAt, checkedAt)) continue;
    if (projectedScore) projectedLineupByEntry.set(entryId, projectedScore.effectiveLineup);
    const totalPoints = previousTotal === null ? null : previousTotal + score.netEventPoints;
    const computedInputRevisionData = buildScoreInputRevision({
      algorithmVersion,
      authorityRevision,
      entryId,
      entryStartedEvent: entryStartedEventById.get(entryId) ?? null,
      picks,
      previousTotal,
      previousTotalsThroughEventId: eventId > 1 ? eventId - 1 : null,
      previousResultEvidence: previousResultEvidenceByEntry.get(entryId) ?? [],
    });
    const revision = contentHash({
      inputRevision: computedInputRevisionData.inputRevision,
      eventPoints: score.eventPoints,
      netEventPoints: score.netEventPoints,
      totalPoints,
      effectiveLineup: projectedScore.effectiveLineup,
    });
    scores.set(entryId, {
      ...score,
      totalPoints,
      revision,
      inputRevision: computedInputRevisionData.inputRevision,
      picksRevision: computedInputRevisionData.picksRevision,
      previousTotalsRevision: computedInputRevisionData.previousTotalsRevision,
      ...(projectedScore && options.includeEffectiveLineup === true
        ? { effectiveLineup: projectedScore.effectiveLineup }
        : {}),
    });
  }

  const materializationRows =
    calculationMode === 'PROJECTED_AUTOSUBS'
      ? Array.from(scores.values())
          .filter(
            (
              score,
            ): score is RevisionedEventLiveManagerScore & {
              inputRevision: string;
              picksRevision: string;
              previousTotalsRevision: string;
            } =>
              typeof score.inputRevision === 'string' &&
              typeof score.picksRevision === 'string' &&
              typeof score.previousTotalsRevision === 'string',
          )
          .map((score) => ({
            entryId: score.entryId,
            inputRevision: score.inputRevision,
            scoreRevision: score.revision,
            calculationMode: 'PROJECTED_AUTOSUBS' as const,
            algorithmVersion: EVENT_LIVE_PROJECTION_ALGORITHM_VERSION,
            scoreSource: 'FPL_EVENT_LIVE' as const,
            livePublicationId: snapshot.manifest.publicationId,
            liveRevision: String(snapshot.manifest.revision),
            liveCheckedAt: checkedAt,
            picksRevision: score.picksRevision,
            picksCheckedAt: score.picksCheckedAt,
            previousTotalsRevision: score.previousTotalsRevision,
            previousTotalsThroughEventId: eventId > 1 ? eventId - 1 : null,
            eventPoints: score.eventPoints,
            netEventPoints: score.netEventPoints,
            totalPoints: score.totalPoints,
            transferCost: score.transferCost,
            effectiveLineup: projectedLineupByEntry.get(score.entryId) ?? null,
          }))
      : [];
  if (materializationRows.length > 0) {
    const materializationResult = await persistManagerScoreMaterializations(
      season,
      eventId,
      materializationRows,
    );
    // A CAS rejection means the durable live pointer, picks, or prior-result
    // input changed while this batch was calculating. Do not return those
    // rows as if they were authoritative; the caller will represent the
    // missing entry as unavailable and a later request will recalculate it.
    for (const entryId of materializationResult.rejectedEntryIds) {
      scores.delete(entryId);
      projectedLineupByEntry.delete(entryId);
    }
  }

  return {
    season: season.seasonCode,
    eventId,
    state: snapshot.state,
    liveRevision: String(snapshot.manifest.revision),
    revision: authorityRevision,
    publicationId: snapshot.manifest.publicationId,
    checkedAt,
    sourceCheckedAt: snapshot.manifest.sourceCheckedAt,
    calculationMode,
    algorithmVersion,
    scores,
  };
}

/** Shared active-manager score authority used by manager-live and H2H. */
export const eventLiveManagerScoreService = {
  load: loadEventLiveManagerScoreBatch,
};
