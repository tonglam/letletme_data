import type { EventLiveManagerScoreBatch } from '../event-live-manager-scores.service';
import type { ManagerLiveScoreRow } from './contracts';
import { contentHash } from '../../utils/content-hash';

const REFRESH_SECONDS = 30;
const STALE_SECONDS = Math.max(90, 3 * REFRESH_SECONDS);

const ageSeconds = (checkedAt: string, now = Date.now()): number => {
  const timestamp = Date.parse(checkedAt);
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 1000) : Infinity;
};

const isFresh = (row: ManagerLiveScoreRow, now = Date.now()): boolean =>
  ageSeconds(row.checkedAt, now) <= REFRESH_SECONDS;

const plusSeconds = (checkedAt: string, seconds: number): string =>
  new Date(Date.parse(checkedAt) + seconds * 1000).toISOString();

/**
 * Project every active score field from one coherent event-live publication.
 *
 * Rank metadata is deliberately treated as an independent input: Entry
 * Summary and Classic standings can enrich ranks, but can never override the
 * score, total or effective lineup supplied by the live publication.
 */
export const projectEventLiveManagerRows = (
  season: string,
  eventId: number,
  entryIds: readonly number[],
  metadataRows: readonly ManagerLiveScoreRow[],
  batch: EventLiveManagerScoreBatch | null,
): ManagerLiveScoreRow[] => {
  if (!batch || batch.season !== season || batch.eventId !== eventId) return [];
  const batchCalculationMode = batch.calculationMode;
  const batchAlgorithmVersion = batch.algorithmVersion;
  const metadataByEntry = new Map(metadataRows.map((row) => [row.entryId, row] as const));
  return entryIds.flatMap((entryId) => {
    const score = batch.scores.get(entryId);
    if (!score) return [];
    const metadataCandidate = metadataByEntry.get(entryId);
    const batchCheckedAt = Date.parse(batch.checkedAt);
    const metadata =
      metadataCandidate &&
      Number.isFinite(batchCheckedAt) &&
      isFresh(metadataCandidate, batchCheckedAt)
        ? metadataCandidate
        : undefined;
    const rankMetadata =
      metadata?.source === 'FPL_ENTRY_SUMMARY'
        ? {
            revision: contentHash({
              entryId,
              eventId,
              source: metadata.source,
              eventRank: metadata.eventRank,
              overallRank: metadata.overallRank,
              leagueRank: metadata.leagueRank,
            }),
            checkedAt: metadata.checkedAt,
            source: 'FPL_ENTRY_SUMMARY' as const,
          }
        : metadata?.source === 'FPL_CLASSIC_STANDINGS'
          ? {
              revision: contentHash({
                entryId,
                eventId,
                source: metadata.source,
                eventRank: metadata.eventRank,
                overallRank: metadata.overallRank,
                leagueRank: metadata.leagueRank,
              }),
              checkedAt: metadata.checkedAt,
              source: 'FPL_CLASSIC_STANDINGS' as const,
            }
          : undefined;
    // Keep the row revision explicitly compositional: score consumers can use
    // provenance.scoreRevision while rank-only refreshes advance the
    // independent rank revision without changing the score revision.
    const compositeRevision = `${score.revision}:${rankMetadata?.revision ?? 'none'}`;
    return [
      {
        ...(metadata && 'revisionAt' in metadata
          ? { revisionAt: (metadata as ManagerLiveScoreRow & { revisionAt?: string }).revisionAt }
          : {}),
        season,
        eventId,
        entryId,
        eventPoints: score.eventPoints,
        netEventPoints: score.netEventPoints,
        totalPoints: score.totalPoints,
        totalScope: 'OVERALL' as const,
        eventRank: metadata?.eventRank ?? null,
        overallRank: metadata?.overallRank ?? null,
        leagueRank: metadata?.leagueRank ?? null,
        source: 'FPL_EVENT_LIVE' as const,
        transferCost: score.transferCost,
        eventPointSemantics:
          score.transferCost === 0 ? ('ZERO_COST_EQUIVALENT' as const) : ('GROSS' as const),
        revision: compositeRevision,
        checkedAt: batch.checkedAt,
        upstreamUpdatedAt: batch.sourceCheckedAt,
        staleAt: plusSeconds(batch.checkedAt, STALE_SECONDS),
        calculationMode: batchCalculationMode,
        algorithmVersion: batchAlgorithmVersion,
        ...(score.effectiveLineup ? { effectiveLineup: score.effectiveLineup } : {}),
        provenance: {
          scoreSource: 'FPL_EVENT_LIVE',
          calculationMode: batchCalculationMode,
          algorithmVersion: batchAlgorithmVersion,
          inputRevision: score.inputRevision ?? score.revision,
          scoreRevision: score.revision,
          rankRevision: rankMetadata?.revision ?? null,
          livePublicationId: batch.publicationId,
          liveRevision: batch.liveRevision,
          liveCheckedAt: batch.checkedAt,
          picksRevision: score.picksRevision ?? null,
          picksCheckedAt: score.picksCheckedAt,
          previousTotalsRevision: score.previousTotalsRevision ?? null,
          previousTotalsThroughEventId: eventId > 1 ? eventId - 1 : null,
          resultRevision: null,
          resultCheckedAt: null,
          dataCheckedAt: null,
          rankSource: rankMetadata?.source ?? null,
          rankCheckedAt: rankMetadata?.checkedAt ?? null,
        },
      },
    ];
  });
};
