import {
  projectEventLiveManagerScore,
  projectOfficialCurrentMultiplierScore,
  type EffectiveLineupRow,
} from '../domain/event-live-manager-projection';
import type {
  EventLiveManagerPick,
  EventLiveManagerScore,
} from '../domain/event-live-manager-score';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  entryEventPicksRepository,
  type EventLiveManagerPickRow,
} from '../repositories/entry-event-picks';
import {
  entryEventResultsRepository,
  type EntryEventResultRevisionEvidence,
} from '../repositories/entry-event-results';
import { entryInfoRepository } from '../repositories/entry-infos';
import type { Fixture } from '../types';
import {
  readEntryLiveInputV2,
  readLivePublicationV2,
  readLivePublicationV2ByReference,
  type LivePublicationRead,
} from '../cache/live-publication-v2';
import { contentHash } from '../utils/content-hash';
import { mapWithConcurrency } from '../utils/async';

export type { EventLiveManagerPickRow } from '../repositories/entry-event-picks';

/**
 * Internal background projection used by H2H/final snapshot jobs.
 *
 * This is intentionally a Redis V2 reader plus a pure calculation. It never
 * reads the retired live-snapshot cache and never writes manager-score
 * materializations. The GraphQL single-entry projector remains the canonical
 * request owner; this batch form exists only for durable background captures.
 */
export type RevisionedEventLiveScore = EventLiveManagerScore & {
  readonly totalPoints: number | null;
  readonly revision: string;
  readonly effectiveLineup?: readonly EffectiveLineupRow[];
  readonly inputRevision?: string;
  readonly picksRevision?: string;
  readonly previousTotalsRevision?: string;
};

export type EventLiveScoreMode = 'OFFICIAL_CURRENT_MULTIPLIERS' | 'PROJECTED_AUTOSUBS';

// This is the only algorithm identity emitted by the V2 live-score lane. The
// projection implementation is shared with the durable result calculators,
// but its V2 publication identity must not be confused with their retired
// manager-materialization version strings.
export const LIVE_POINTS_V2_ALGORITHM_VERSION = 'live-points-v2-algorithm-1' as const;
export const LIVE_POINTS_V2_OFFICIAL_ALGORITHM_VERSION =
  'live-points-v2-official-current-multipliers-1' as const;

export type EventLiveScoreBatch = {
  readonly season: string;
  readonly eventId: number;
  readonly state: 'scheduled' | 'live' | 'settled';
  readonly scoreCoreRevision: string;
  readonly generation: number;
  readonly publicationId: string;
  readonly sourceCheckedAt: string;
  readonly calculationMode: EventLiveScoreMode;
  readonly algorithmVersion: string;
  readonly scores: ReadonlyMap<number, RevisionedEventLiveScore>;
};

export type EventLiveScorePreloadedInputs = {
  readonly pickRows: readonly EventLiveManagerPickRow[];
  readonly entryInfos: readonly { id: number; startedEvent: number | null }[];
  readonly previousResultEvidence?: readonly EntryEventResultRevisionEvidence[];
};

/** Age is a delivery-state signal, never an availability expiry for a complete LKG. */
export const EVENT_LIVE_PICKS_MAX_AGE_MS = 15 * 60_000;
export const EVENT_LIVE_HEARTBEAT_MAX_AGE_MS = 90_000;

export function hasCompleteAggregateCoverage(
  row: { eventCount?: number; firstEventId?: number; lastEventId?: number } | undefined,
  startEventId: number,
  endEventId: number,
): boolean {
  return (
    row !== undefined &&
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
  void maxAgeMs;
  const picksTimestamp = Date.parse(picksCheckedAt);
  const liveTimestamp = Date.parse(liveCheckedAt);
  return (
    Number.isFinite(picksTimestamp) &&
    Number.isFinite(liveTimestamp) &&
    picksTimestamp <= liveTimestamp
  );
}

export function eventLiveProjectedPicksAreCoherent(
  picksCheckedAt: string,
  liveCheckedAt: string,
): boolean {
  const picksTimestamp = Date.parse(picksCheckedAt);
  const liveTimestamp = Date.parse(liveCheckedAt);
  return (
    Number.isFinite(picksTimestamp) &&
    Number.isFinite(liveTimestamp) &&
    picksTimestamp <= liveTimestamp
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

export function eventLiveAuthorityCheckedAt(snapshot: LivePublicationRead): string {
  return snapshot.publication.sourceCheckedAt;
}

export async function loadFreshEventLiveAuthoritySnapshot(
  season: FplSeasonRef,
  eventId: number,
  reference?: { readonly publicationId: string; readonly generation: number },
  nowMs = Date.now(),
): Promise<LivePublicationRead | null> {
  void nowMs;
  const snapshot = reference
    ? await readLivePublicationV2ByReference({ season: season.seasonCode, eventId }, reference)
    : await readLivePublicationV2({ season: season.seasonCode, eventId });
  if (
    !snapshot ||
    snapshot.publication.eventId !== eventId ||
    snapshot.publication.season !== season.seasonCode ||
    !Number.isFinite(Date.parse(snapshot.publication.sourceCheckedAt))
  ) {
    return null;
  }
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
  readonly algorithmVersion: string;
  readonly authorityRevision: string;
  readonly entryId: number;
  readonly picks: readonly {
    readonly position: number;
    readonly elementId: number;
    readonly elementType?: number;
    readonly teamId?: number | null;
    readonly multiplier: number;
    readonly isCaptain: boolean;
    readonly isViceCaptain: boolean;
    readonly transfersCost: number | null;
    readonly sourceUpdatedAt: Date;
    readonly activeChip?: string | null;
  }[];
  readonly entryStartedEvent?: number | null;
  readonly previousTotal: number | null;
  readonly previousTotalsThroughEventId?: number | null;
  readonly previousResultEvidence?: readonly {
    readonly entryId: number;
    readonly eventId: number;
    readonly sourceResultId: number | null;
    readonly eventNetPoints: number | null;
    readonly richSyncedAt: Date | null;
    readonly updatedAt: Date;
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

function picksMatchInput(
  rows: readonly {
    entryId: number;
    position: number;
    elementId: number;
    multiplier: number;
    isCaptain: boolean;
    isViceCaptain: boolean;
    transfers: number | null;
    transfersCost: number | null;
    activeChip: string | null;
  }[],
  input: NonNullable<Awaited<ReturnType<typeof readEntryLiveInputV2>>>['input'],
): boolean {
  if (rows.length !== 15) return false;
  const expected = new Map(input.picksBase.picks.map((pick) => [pick.position, pick]));
  return rows.every((row) => {
    const pick = expected.get(row.position);
    return Boolean(
      pick &&
        row.elementId === pick.element &&
        row.multiplier === pick.multiplier &&
        row.isCaptain === pick.isCaptain &&
        row.isViceCaptain === pick.isViceCaptain &&
        (row.position === 1
          ? row.transfersCost === input.picksBase.transferCost
          : row.transfersCost === null) &&
        (row.position === 1
          ? row.transfers === input.picksBase.transferCount
          : row.transfers === null) &&
        (row.position === 1 ? row.activeChip === input.picksBase.chip : row.activeChip === null),
    );
  });
}

async function loadEventLiveScoreBatch(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  options: {
    readonly includeEffectiveLineup?: boolean;
    readonly liveRef?: { readonly publicationId: string; readonly generation: number };
    readonly requestedCalculationMode?: EventLiveScoreMode;
    /**
     * Background captures may already own a repeatable-read transaction. In
     * that case the caller must provide the rows read by that transaction so
     * this pure projection does not open a second application connection and
     * deadlock a pool with max=1.
     */
    readonly preloadedInputs?: EventLiveScorePreloadedInputs;
  } = {},
): Promise<EventLiveScoreBatch | null> {
  const uniqueEntryIds = [...new Set(entryIds)];
  if (uniqueEntryIds.length === 0) return null;
  const calculationMode = options.requestedCalculationMode ?? 'PROJECTED_AUTOSUBS';
  const algorithmVersion =
    calculationMode === 'PROJECTED_AUTOSUBS'
      ? LIVE_POINTS_V2_ALGORITHM_VERSION
      : LIVE_POINTS_V2_OFFICIAL_ALGORITHM_VERSION;
  const authority = await loadFreshEventLiveAuthoritySnapshot(season, eventId, options.liveRef);
  if (!authority) return null;

  const [pickRows, entryInputs, entryInfos, previousResultEvidence] = await Promise.all([
    options.preloadedInputs?.pickRows ??
      entryEventPicksRepository.findScoringPicksByEventAndEntryIds(season, eventId, uniqueEntryIds),
    mapWithConcurrency(
      uniqueEntryIds,
      32,
      async (entryId) =>
        [
          entryId,
          await readEntryLiveInputV2({ season: season.seasonCode, eventId, entryId }),
        ] as const,
    ),
    options.preloadedInputs?.entryInfos ?? entryInfoRepository.findByIds(season, uniqueEntryIds),
    options.preloadedInputs?.previousResultEvidence ??
      (eventId > 1
        ? entryEventResultsRepository.findRevisionEvidenceByEntry(
            season,
            uniqueEntryIds,
            1,
            eventId - 1,
            { finalizedOnly: true },
          )
        : Promise.resolve([])),
  ]);
  const rowsByEntry = new Map<number, EventLiveManagerPickRow[]>();
  for (const row of pickRows) {
    const rows = rowsByEntry.get(row.entryId) ?? [];
    rows.push(row);
    rowsByEntry.set(row.entryId, rows);
  }
  const inputByEntry = new Map(entryInputs);
  const startedByEntry = new Map(
    entryInfos.map((entry) => [entry.id, entry.startedEvent] as const),
  );
  const liveByElement = new Map(authority.eventLives.map((row) => [row.elementId, row] as const));
  const scores = new Map<number, RevisionedEventLiveScore>();
  const authorityRevision = `live-points-v2:${authority.publication.publicationId}:${authority.publication.generation}:${authority.publication.revisions.scoreCore.revision}`;

  for (const entryId of uniqueEntryIds) {
    const inputRead = inputByEntry.get(entryId);
    const rows = rowsByEntry.get(entryId) ?? [];
    if (!inputRead || !picksMatchInput(rows, inputRead.input)) continue;
    // Never combine a newer picks publication with an older live authority;
    // that vector did not exist as one coherent observation.
    if (
      !eventLiveProjectedPicksAreCoherent(
        inputRead.publication.sourceCheckedAt,
        authority.publication.sourceCheckedAt,
      )
    )
      continue;
    const picks = rows.map((row) => ({
      entryId: row.entryId,
      position: row.position,
      elementId: row.elementId,
      multiplier: row.multiplier,
      isCaptain: row.isCaptain,
      isViceCaptain: row.isViceCaptain,
      transfers: row.transfers,
      transfersCost: row.transfersCost,
      sourceUpdatedAt: row.sourceUpdatedAt,
      elementType: row.elementType,
      teamId: row.teamId,
      activeChip: row.activeChip,
    })) satisfies EventLiveManagerPick[];
    const firstScoringEvent = Math.max(1, startedByEntry.get(entryId) ?? 1);
    const previousTotals = inputRead.input.previousTotals;
    const previousTotal =
      eventId === firstScoringEvent
        ? 0
        : previousTotals?.throughEventId === eventId - 1
          ? previousTotals.totalPoints
          : null;
    const previousEntryResults = previousResultEvidence.filter(
      (result) =>
        result.entryId === entryId &&
        result.eventId >= firstScoringEvent &&
        result.eventId < eventId,
    );
    const inputRevisionData = buildScoreInputRevision({
      algorithmVersion,
      authorityRevision,
      entryId,
      entryStartedEvent: startedByEntry.get(entryId) ?? null,
      picks,
      previousTotal,
      previousTotalsThroughEventId: eventId > firstScoringEvent ? eventId - 1 : null,
      previousResultEvidence: previousEntryResults,
    });
    // picksBase.revision is the source contract's content identity. The
    // richer picksRevision below additionally includes event team and player
    // metadata used by the calculator, so the two hashes intentionally differ.
    // picksMatchInput above is the exact rowset-to-source guard; comparing the
    // two unrelated hash domains would make every valid score disappear.
    const projected =
      calculationMode === 'PROJECTED_AUTOSUBS'
        ? projectEventLiveManagerScore({
            entryId,
            picks,
            liveByElement,
            fixtures: authority.fixtures as readonly Fixture[],
            reportedEventPoints: inputRead.input.picksBase.reportedEventPoints,
          })
        : projectOfficialCurrentMultiplierScore({ entryId, picks, liveByElement });
    if (!projected) continue;
    const totalPoints = previousTotal === null ? null : previousTotal + projected.netEventPoints;
    const revision = contentHash({
      inputRevision: inputRevisionData.inputRevision,
      eventPoints: projected.eventPoints,
      netEventPoints: projected.netEventPoints,
      totalPoints,
      effectiveLineup: projected.effectiveLineup,
    });
    scores.set(entryId, {
      ...projected,
      totalPoints,
      revision,
      inputRevision: inputRevisionData.inputRevision,
      picksRevision: inputRevisionData.picksRevision,
      previousTotalsRevision: inputRevisionData.previousTotalsRevision,
      ...(options.includeEffectiveLineup ? { effectiveLineup: projected.effectiveLineup } : {}),
    });
  }

  return {
    season: season.seasonCode,
    eventId,
    state:
      authority.publication.state === 'FINALIZED'
        ? 'settled'
        : authority.publication.state === 'PRE_DEADLINE' ||
            authority.publication.state === 'PICKS_WAIT'
          ? 'scheduled'
          : 'live',
    scoreCoreRevision: authority.publication.revisions.scoreCore.revision,
    generation: authority.publication.generation,
    publicationId: authority.publication.publicationId,
    sourceCheckedAt: authority.publication.sourceCheckedAt,
    calculationMode,
    algorithmVersion,
    scores,
  };
}

export const eventLiveV2ScoreService = {
  load: loadEventLiveScoreBatch,
};
