import {
  readLiveSnapshotCache,
  type LiveSnapshotCacheContents,
} from '../cache/live-snapshot-cache';
import {
  deriveEventLiveManagerScore,
  type EventLiveManagerScore,
} from '../domain/event-live-manager-score';
import type { FplSeasonRef } from '../domain/fpl-season';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { contentHash } from '../utils/content-hash';

export type RevisionedEventLiveManagerScore = EventLiveManagerScore & {
  totalPoints: number | null;
  revision: string;
};

export type EventLiveManagerScoreBatch = {
  season: string;
  eventId: number;
  state: 'scheduled' | 'live' | 'settled';
  revision: string;
  publicationId: string;
  checkedAt: string;
  sourceCheckedAt: string;
  scores: ReadonlyMap<number, RevisionedEventLiveManagerScore>;
};

export const EVENT_LIVE_PICKS_MAX_AGE_MS = 15 * 60_000;
export const EVENT_LIVE_HEARTBEAT_MAX_AGE_MS = 15 * 60_000;

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
    Math.abs(liveTimestamp - picksTimestamp) <= maxAgeMs
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
  nowMs = Date.now(),
): Promise<LiveSnapshotCacheContents | null> {
  const snapshot = await readLiveSnapshotCache(season.seasonCode, eventId);
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

export function buildEventLiveScoreRevision(input: {
  authorityRevision: string;
  entryId: number;
  eventPoints: number;
  transferCost: number;
  previousTotal: number | null;
  totalPoints: number | null;
}): string {
  const scoreHash = contentHash({
    authorityRevision: input.authorityRevision,
    entryId: input.entryId,
    eventPoints: input.eventPoints,
    transferCost: input.transferCost,
    previousTotal: input.previousTotal,
    totalPoints: input.totalPoints,
  }).slice(0, 16);
  return `${input.authorityRevision}:entry:${input.entryId}:${scoreHash}`;
}

async function loadEventLiveManagerScoreBatch(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
): Promise<EventLiveManagerScoreBatch | null> {
  const uniqueEntryIds = Array.from(new Set(entryIds));
  if (uniqueEntryIds.length === 0) return null;

  const snapshot = await loadFreshEventLiveAuthoritySnapshot(season, eventId);
  if (!snapshot) return null;

  const pointsByElement = new Map<number, number>();
  for (const row of snapshot.eventLives) {
    pointsByElement.set(row.elementId, row.totalPoints);
  }

  const checkedAt = eventLiveAuthorityCheckedAt(snapshot);

  const [pickRows, previousTotals] = await Promise.all([
    entryEventPicksRepository.findScoringPicksByEventAndEntryIds(season, eventId, uniqueEntryIds),
    eventId === 1
      ? Promise.resolve([])
      : entryEventResultsRepository.aggregateTotalsByEntry(season, uniqueEntryIds, 1, eventId - 1),
  ]);
  const picksByEntry = new Map<number, typeof pickRows>();
  for (const pick of pickRows) {
    const rows = picksByEntry.get(pick.entryId) ?? [];
    rows.push(pick);
    picksByEntry.set(pick.entryId, rows);
  }
  const previousTotalByEntry = new Map(
    previousTotals
      .filter((row) => hasCompleteAggregateCoverage(row, 1, eventId - 1))
      .map((row) => [row.entryId, row.totalNetPoints] as const),
  );

  const authorityRevision = `fpl:live:${snapshot.manifest.publicationId}:${snapshot.manifest.revision}`;
  const scores = new Map<number, RevisionedEventLiveManagerScore>();
  for (const entryId of uniqueEntryIds) {
    const score = deriveEventLiveManagerScore(
      entryId,
      picksByEntry.get(entryId) ?? [],
      pointsByElement,
    );
    if (!score) continue;
    if (!eventLivePicksAreFresh(score.picksCheckedAt, checkedAt)) continue;
    const previousTotal = eventId === 1 ? 0 : (previousTotalByEntry.get(entryId) ?? null);
    const totalPoints = previousTotal === null ? null : previousTotal + score.netEventPoints;
    const revision = buildEventLiveScoreRevision({
      authorityRevision,
      entryId,
      eventPoints: score.eventPoints,
      transferCost: score.transferCost,
      previousTotal,
      totalPoints,
    });
    scores.set(entryId, {
      ...score,
      totalPoints,
      revision,
    });
  }

  return {
    season: season.seasonCode,
    eventId,
    state: snapshot.state,
    revision: authorityRevision,
    publicationId: snapshot.manifest.publicationId,
    checkedAt,
    sourceCheckedAt: snapshot.manifest.sourceCheckedAt,
    scores,
  };
}

/** Shared active-manager score authority used by manager-live and H2H. */
export const eventLiveManagerScoreService = {
  load: loadEventLiveManagerScoreBatch,
};
