import { readLiveSnapshotCache } from '../cache/live-snapshot-cache';
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

async function loadEventLiveManagerScoreBatch(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
): Promise<EventLiveManagerScoreBatch | null> {
  const uniqueEntryIds = Array.from(new Set(entryIds));
  if (uniqueEntryIds.length === 0) return null;

  const snapshot = await readLiveSnapshotCache(season.seasonCode, eventId);
  if (!snapshot || snapshot.eventId !== eventId || snapshot.season !== season.seasonCode) {
    return null;
  }

  const pointsByElement = new Map<number, number>();
  for (const row of snapshot.eventLives) {
    if (
      row.eventId !== eventId ||
      !Number.isSafeInteger(row.elementId) ||
      row.elementId <= 0 ||
      !Number.isSafeInteger(row.totalPoints) ||
      pointsByElement.has(row.elementId)
    ) {
      return null;
    }
    pointsByElement.set(row.elementId, row.totalPoints);
  }

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
    previousTotals.map((row) => [row.entryId, row.totalNetPoints] as const),
  );

  const authorityRevision = `fpl:live:${snapshot.manifest.publicationId}:${snapshot.manifest.revision}`;
  const checkedAt = snapshot.manifest.lastSuccessfulFetchAt ?? snapshot.manifest.sourceCheckedAt;
  const scores = new Map<number, RevisionedEventLiveManagerScore>();
  for (const entryId of uniqueEntryIds) {
    const score = deriveEventLiveManagerScore(
      entryId,
      picksByEntry.get(entryId) ?? [],
      pointsByElement,
    );
    if (!score) continue;
    const previousTotal = eventId === 1 ? 0 : (previousTotalByEntry.get(entryId) ?? null);
    const totalPoints = previousTotal === null ? null : previousTotal + score.netEventPoints;
    const scoreHash = contentHash({
      authorityRevision,
      entryId,
      picksCheckedAt: score.picksCheckedAt,
      eventPoints: score.eventPoints,
      transferCost: score.transferCost,
    }).slice(0, 16);
    scores.set(entryId, {
      ...score,
      totalPoints,
      revision: `${authorityRevision}:entry:${entryId}:${scoreHash}`,
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
