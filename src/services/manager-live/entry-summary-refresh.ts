// Manager Live provider entry implementation.
import type Redis from 'ioredis';
import { type ManagerScoreScope } from '../../repositories/live-window';
import { FPLClientError } from '../../utils/errors';
import { logWarn } from '../../utils/logger';
import type { FplSeasonRef } from '../../domain/fpl-season';
import {
  isNewerClassicOverallRankPublicationOrder,
  isPositiveOverallRank,
  managerSummaryFetchBatches,
  selectClassicSummaryOverallRank,
  selectEarlierManagerLiveObservationAt,
  shouldPreserveClassicStandingForRank,
  type ManagerSummaryFetchPriority,
} from '../../domain/manager-live-fallback';
import type { ManagerLiveScoreRow } from './contracts';
import {
  CachedRow,
  EntrySummaryRefreshResult,
  ManagerSummaryRefreshError,
  REFRESH_SECONDS,
  STALE_SECONDS,
  entryScope,
  mergeLatestManagerLiveRow,
  plusSeconds,
  scopeKey,
  toEntrySummaryRow,
  withOverallRank,
  withPreservedOverallRank,
  withRevision,
} from './publication-store';
import { isFresh } from './result-assembly';
import {
  EntrySummaryRefreshDependencies,
  managerLivePublicationKey,
  productionEntrySummaryRefreshDependencies,
} from './provider-coordination';

export const refreshEntrySummaries = async (
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  rows: Map<number, CachedRow>,
  redis: Redis | null,
  scope: ManagerScoreScope = entryScope,
  options: {
    maxFetches?: number;
    priority?: ManagerSummaryFetchPriority;
    force?: boolean;
    preserveClassicStanding?: boolean;
    assertLeaseOwned?: () => Promise<void>;
    requestDeadlineMs?: number;
  } = {},
  dependencies: Partial<EntrySummaryRefreshDependencies> = {},
): Promise<EntrySummaryRefreshResult> => {
  const now = dependencies.clock?.now ?? productionEntrySummaryRefreshDependencies.clock.now;
  const nowIso = (): string => now().toISOString();
  const fetchDistributedManagerSummary =
    dependencies.fetchSummary ?? productionEntrySummaryRefreshDependencies.fetchSummary;
  const runManagerLivePublication =
    dependencies.runPublication ?? productionEntrySummaryRefreshDependencies.runPublication;
  const readClassicPublicationState =
    dependencies.readPublicationState ??
    productionEntrySummaryRefreshDependencies.readPublicationState;
  const readCachedRowsForPublication =
    dependencies.readCachedRowsForPublication ??
    productionEntrySummaryRefreshDependencies.readCachedRowsForPublication;
  const readDatabaseOrderingTimestamp =
    dependencies.readOrderingTimestamp ??
    productionEntrySummaryRefreshDependencies.readOrderingTimestamp;
  const writeCheckpointRows =
    dependencies.writeCheckpointRows ??
    productionEntrySummaryRefreshDependencies.writeCheckpointRows;
  const writeRows = dependencies.writeRows ?? productionEntrySummaryRefreshDependencies.writeRows;
  const writeClassicRowsMonotonically =
    dependencies.writeCache ?? productionEntrySummaryRefreshDependencies.writeCache;
  const reconcileClassicRowsAfterCachePublication =
    dependencies.reconcileCache ?? productionEntrySummaryRefreshDependencies.reconcileCache;
  const targets = entryIds
    .filter((entryId) => options.force || !rows.has(entryId) || !isFresh(rows.get(entryId)!))
    .slice(0, options.maxFetches ?? Number.POSITIVE_INFINITY);
  if (targets.length === 0) {
    return { errorCode: null, refreshedEntryIds: [], overallRankRefreshedEntryIds: [] };
  }

  const refreshed: ManagerLiveScoreRow[] = [];
  const refreshedEntryIds: number[] = [];
  const overallRankRefreshedEntryIds: number[] = [];
  let refreshErrorCode: ManagerSummaryRefreshError = null;
  const classicScope = scope.scopeType === 'CLASSIC_LEAGUE';
  const publicationKey = managerLivePublicationKey(season.seasonCode, eventId, scope);
  for (const batch of managerSummaryFetchBatches(targets)) {
    let fallbackBaselineRows: Map<number, CachedRow | null> | null = null;
    if (classicScope && options.preserveClassicStanding !== true) {
      try {
        // Define fallback start with a successful durable read under the same
        // scope lock used by publishers. A null row now means confirmed absent,
        // never "unknown because the request-path checkpoint read failed".
        const baselineState = await runManagerLivePublication(publicationKey, () =>
          readClassicPublicationState(season, eventId, scope, batch, rows),
        );
        fallbackBaselineRows = new Map(
          batch.map((entryId) => [entryId, baselineState.rows.get(entryId) ?? null] as const),
        );
      } catch (error) {
        refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
        logWarn('Official manager fallback baseline read failed', {
          eventId,
          scope: scopeKey(scope),
          error: error instanceof Error ? error.message : 'unknown',
        });
        continue;
      }
    }
    const completed = await Promise.all(
      batch.map(async (entryId) => {
        try {
          const observation = await fetchDistributedManagerSummary(
            redis,
            season.seasonCode,
            eventId,
            entryId,
            options.priority,
            // Every shared observation needs a scope-independent ordering
            // marker. A summary fetched through the ENTRY scope may later be
            // reused by the Classic scope. If the best-effort reservation is
            // unavailable, the null marker is rejected by Classic rather than
            // blocking this direct-entry refresh.
            publicationKey,
            classicScope,
            options.requestDeadlineMs,
          );
          return {
            entryId,
            summary: observation.summary,
            // A waiter must preserve the upstream observation time from the
            // shared result. Stamping a fresh local time here would extend a
            // nearly-expired summary for another full refresh interval.
            observedAt: observation.observedAt,
            publicationOrder: observation.publicationOrder,
          };
        } catch (error) {
          if (error instanceof FPLClientError && error.status === 429) {
            refreshErrorCode = 'UPSTREAM_RATE_LIMITED';
          } else {
            refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
          }
          logWarn('Official manager entry summary refresh failed', {
            entryId,
            eventId,
            error: error instanceof FPLClientError ? (error.code ?? error.status) : 'unknown',
          });
          return null;
        }
      }),
    );
    const successful = completed.filter(
      (result): result is NonNullable<typeof result> => result !== null,
    );
    if (successful.length === 0) continue;
    const publicationCheckedAt = nowIso();
    const targetEntryIds = successful.map(({ entryId }) => entryId);
    const cachedPublicationRows = classicScope
      ? await readCachedRowsForPublication(redis, season.seasonCode, eventId, scope, targetEntryIds)
      : new Map<number, CachedRow>();

    const composeAndPublishBatch = async (
      reReadLatest: boolean,
    ): Promise<{
      rows: ManagerLiveScoreRow[];
      refreshedEntryIds: number[];
      overallRankRefreshedEntryIds: number[];
      cachePublicationOrder: string | null;
      overallRankPublicationOrders: Map<number, string>;
      metadata: Record<string, unknown>;
      redisPublished: boolean;
    }> => {
      const publicationState = reReadLatest
        ? await readClassicPublicationState(
            season,
            eventId,
            scope,
            targetEntryIds,
            rows,
            cachedPublicationRows,
          )
        : null;
      const latestRows = publicationState?.rows ?? rows;

      const batchRefreshedEntryIds: number[] = [];
      const batchOverallRankRefreshedEntryIds: number[] = [];
      const acceptedOverallRankPublicationOrders = new Map<number, string>();
      const overallRankPublicationOrders = new Map(
        publicationState?.overallRankPublicationStartedAtByEntryId ?? [],
      );
      const publishedRows = successful.map(
        ({ entryId, summary, observedAt, publicationOrder: summaryPublicationOrder }) => {
          const existing = latestRows.get(entryId) ?? rows.get(entryId);
          // Every Classic publication re-reads the checkpoint. Explicit OR
          // enrichment always retains standings; fallback does so only when a
          // standing advanced after this Summary wave began.
          const candidate = shouldPreserveClassicStandingForRank(
            options.preserveClassicStanding,
            existing,
            reReadLatest && options.preserveClassicStanding !== true
              ? (fallbackBaselineRows?.get(entryId) ?? null)
              : undefined,
          )
            ? (() => {
                const { revision: _revision, ...classicRow } = existing;
                // A Classic row combines two independently observed sources:
                // phase totals from standings and OR from Entry Summary. Its
                // freshness cannot be newer than either observation.
                const checkedAt = selectEarlierManagerLiveObservationAt(
                  classicRow.checkedAt,
                  observedAt,
                );
                return withRevision({
                  ...classicRow,
                  checkedAt,
                  staleAt: plusSeconds(checkedAt, STALE_SECONDS),
                  // Classic standings owns event/phase totals and league rank;
                  // the entry summary owns the season-wide FPL OR.
                  overallRank: summary.summary_overall_rank ?? null,
                });
              })()
            : toEntrySummaryRow(season.seasonCode, eventId, entryId, summary, observedAt);
          batchRefreshedEntryIds.push(entryId);
          if (isPositiveOverallRank(summary.summary_overall_rank)) {
            batchOverallRankRefreshedEntryIds.push(entryId);
          }
          const publicationOrderIsNewer =
            reReadLatest &&
            isNewerClassicOverallRankPublicationOrder(
              summaryPublicationOrder ?? '',
              publicationState?.overallRankPublicationStartedAtByEntryId.get(entryId),
            );
          const acceptOverallRank =
            publicationOrderIsNewer && isPositiveOverallRank(summary.summary_overall_rank);
          const orderedCandidate = reReadLatest
            ? withOverallRank(
                candidate,
                selectClassicSummaryOverallRank(
                  candidate.overallRank,
                  existing?.overallRank,
                  acceptOverallRank,
                ),
              )
            : candidate;
          let merged = reReadLatest
            ? mergeLatestManagerLiveRow(existing, orderedCandidate)
            : withPreservedOverallRank(candidate, existing?.overallRank);
          if (acceptOverallRank && isPositiveOverallRank(summary.summary_overall_rank)) {
            // mergeLatestManagerLiveRow may select a newer Classic standings
            // row after the Summary rank was applied. Reapply the bounded
            // observation time so the combined row cannot outlive either
            // source's evidence.
            const checkedAt = selectEarlierManagerLiveObservationAt(
              merged.checkedAt,
              orderedCandidate.checkedAt,
            );
            if (
              merged.overallRank !== summary.summary_overall_rank ||
              merged.checkedAt !== checkedAt
            ) {
              const { revision: _revision, ...withoutRevision } = merged;
              merged = withRevision({
                ...withoutRevision,
                overallRank: summary.summary_overall_rank,
                checkedAt,
                staleAt: plusSeconds(checkedAt, STALE_SECONDS),
              });
            }
          }
          if (acceptOverallRank && summaryPublicationOrder) {
            acceptedOverallRankPublicationOrders.set(entryId, summaryPublicationOrder);
            overallRankPublicationOrders.set(entryId, summaryPublicationOrder);
          }
          return merged;
        },
      );

      const metadata = {
        season: season.seasonCode,
        eventId,
        source: 'FPL_ENTRY_SUMMARY',
        rowCount: refreshed.length + publishedRows.length,
        checkedAt: publicationCheckedAt,
        revision: publishedRows[0]!.revision,
        nextRefreshAt: new Date(now().getTime() + REFRESH_SECONDS * 1000).toISOString(),
      };
      if (classicScope) {
        await options.assertLeaseOwned?.();
        const checkpointPublished = await writeCheckpointRows(
          season,
          eventId,
          scope,
          publishedRows,
          acceptedOverallRankPublicationOrders,
        );
        if (!checkpointPublished) {
          throw new Error('Classic entry-summary checkpoint publication failed');
        }
        const cachePublicationOrder = (await readDatabaseOrderingTimestamp()).exact;
        return {
          rows: publishedRows,
          refreshedEntryIds: batchRefreshedEntryIds,
          overallRankRefreshedEntryIds: batchOverallRankRefreshedEntryIds,
          cachePublicationOrder,
          overallRankPublicationOrders,
          metadata,
          redisPublished: true,
        };
      }

      const redisPublished = await writeRows(
        redis,
        season.seasonCode,
        eventId,
        scope,
        publishedRows,
        metadata,
        'entry-summary',
      );
      return {
        rows: publishedRows,
        refreshedEntryIds: batchRefreshedEntryIds,
        overallRankRefreshedEntryIds: batchOverallRankRefreshedEntryIds,
        cachePublicationOrder: null,
        overallRankPublicationOrders,
        metadata,
        redisPublished,
      };
    };

    // Reconcile and publish only after FPL I/O has completed. The durable
    // positive-OR ordering marker rejects an earlier delayed response even if
    // a later valid fetch returned the unchanged rank or Redis is unavailable.
    let publishedBatch: Awaited<ReturnType<typeof composeAndPublishBatch>>;
    try {
      publishedBatch = classicScope
        ? await runManagerLivePublication(publicationKey, () => composeAndPublishBatch(true))
        : await composeAndPublishBatch(false);
    } catch (error) {
      refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
      logWarn('Official manager entry-summary publication failed', {
        eventId,
        scope: scopeKey(scope),
        error: error instanceof Error ? error.message : 'unknown',
      });
      continue;
    }
    const checkpointPublished = classicScope
      ? true
      : await writeCheckpointRows(season, eventId, scope, publishedBatch.rows);
    if (!checkpointPublished && !publishedBatch.redisPublished) {
      refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
      logWarn('Official manager summary had no durable publication', {
        eventId,
        scope: scopeKey(scope),
        entryCount: publishedBatch.rows.length,
      });
      continue;
    }
    let responseRows = publishedBatch.rows;
    if (classicScope) {
      await options.assertLeaseOwned?.();
      const cacheUpdatedEntryIds = await writeClassicRowsMonotonically(
        redis,
        season.seasonCode,
        eventId,
        scope,
        publishedBatch.rows,
        publishedBatch.metadata,
        'entry-summary',
        publishedBatch.cachePublicationOrder!,
        publishedBatch.overallRankPublicationOrders,
      );
      responseRows = await reconcileClassicRowsAfterCachePublication(
        redis,
        season,
        eventId,
        scope,
        publishedBatch.rows,
        cacheUpdatedEntryIds,
      );
    }
    for (const row of responseRows) rows.set(row.entryId, row);
    refreshedEntryIds.push(...publishedBatch.refreshedEntryIds);
    overallRankRefreshedEntryIds.push(...publishedBatch.overallRankRefreshedEntryIds);
    refreshed.push(...responseRows);
  }
  return {
    errorCode: refreshErrorCode,
    refreshedEntryIds,
    overallRankRefreshedEntryIds,
  };
};
