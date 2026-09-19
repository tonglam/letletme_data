import { randomUUID } from 'node:crypto';

import { readCoreSnapshotLifecycle } from '../cache/core-snapshot-cache';
import { redisSingleton } from '../cache/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { eventRepository } from '../repositories/events';
import { syncCoreSnapshot } from './core-snapshot.service';
import type { LiveLifecycleState } from './live-lifecycle-orchestrator';
import { logError, logInfo } from '../utils/logger';

/**
 * Average Team is a bootstrap/core fact. Refresh it at a lower cadence than
 * the 30-second event-live publication while the event is settling, then do
 * one forced canonical refresh for the terminal final publication.
 */
export const LIVE_AVERAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const LIVE_AVERAGE_REFRESH_LOCK_TTL_MS = 120_000;
const LIVE_AVERAGE_FINAL_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

type FreshCoreSource = Readonly<{
  fresh: boolean;
  sourceCheckedAt: string | null;
  revision: number | null;
  publicationId: string | null;
}>;

type FinalAverageRefreshMarker = Readonly<{
  finalizationAt: string;
  coreRevision: number;
  corePublicationId: string;
  sourceCheckedAt: string;
}>;

export type LiveAverageRefreshResult = Readonly<{
  ready: boolean;
  refreshed: boolean;
  reason:
    | 'outside-refresh-window'
    | 'fresh'
    | 'refresh-complete'
    | 'final-refresh-complete'
    | 'refresh-in-flight'
    | 'core-unavailable'
    | 'average-unavailable'
    | 'refresh-failed'
    | 'finalization-boundary-unavailable';
  sourceCheckedAt: string | null;
}>;

export function shouldRefreshLiveAverage(
  sourceCheckedAt: Date | string | null | undefined,
  now = new Date(),
  intervalMs = LIVE_AVERAGE_REFRESH_INTERVAL_MS,
): boolean {
  const checkedAtMs =
    sourceCheckedAt instanceof Date ? sourceCheckedAt.getTime() : Date.parse(sourceCheckedAt ?? '');
  return !Number.isFinite(checkedAtMs) || now.getTime() - checkedAtMs >= intervalMs;
}

function refreshLockKey(seasonCode: string): string {
  return `llm:data:v2:fpl:core:${seasonCode}:live-average-refresh`;
}

function finalRefreshKey(seasonCode: string, eventId: number): string {
  return `llm:data:v2:fpl:core:${seasonCode}:live-average-final:${eventId}`;
}

async function releaseRefreshLock(key: string, token: string): Promise<void> {
  const redis = await redisSingleton.getClient();
  await redis.eval(
    `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`,
    1,
    key,
    token,
  );
}

async function readFreshCoreSource(seasonCode: string, now: Date): Promise<FreshCoreSource> {
  const lifecycle = await readCoreSnapshotLifecycle(seasonCode);
  const sourceCheckedAt = lifecycle?.manifest.sourceCheckedAt ?? null;
  return {
    fresh: !shouldRefreshLiveAverage(sourceCheckedAt, now),
    sourceCheckedAt,
    revision: lifecycle?.manifest.revision ?? null,
    publicationId: lifecycle?.manifest.publicationId ?? null,
  };
}

function parseFinalAverageRefreshMarker(raw: string | null): FinalAverageRefreshMarker | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<FinalAverageRefreshMarker>;
    if (
      typeof value.finalizationAt !== 'string' ||
      !Number.isFinite(Date.parse(value.finalizationAt)) ||
      typeof value.coreRevision !== 'number' ||
      !Number.isSafeInteger(value.coreRevision) ||
      value.coreRevision <= 0 ||
      typeof value.corePublicationId !== 'string' ||
      value.corePublicationId.length === 0 ||
      typeof value.sourceCheckedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.sourceCheckedAt))
    ) {
      return null;
    }
    return value as FinalAverageRefreshMarker;
  } catch {
    // Older marker values were plain timestamps. Treat them as legacy and
    // force one revision-bound refresh rather than trusting them.
    return null;
  }
}

function finalAverageRefreshMarkerMatches(
  raw: string | null,
  current: FreshCoreSource,
  finalizationAt: string | null,
): boolean {
  const marker = parseFinalAverageRefreshMarker(raw);
  return Boolean(
    marker &&
      finalizationAt !== null &&
      marker.finalizationAt === finalizationAt &&
      marker.coreRevision === current.revision &&
      marker.corePublicationId === current.publicationId &&
      marker.sourceCheckedAt === current.sourceCheckedAt,
  );
}

async function hasCanonicalAverageEntryScore(
  season: FplSeasonRef,
  eventId: number,
): Promise<boolean> {
  const event = await eventRepository.findById(season, eventId);
  return event?.averageEntryScore !== null && Number.isFinite(event?.averageEntryScore);
}

/**
 * Establish a fresh canonical average before the live H2H mirror reads
 * `fpl.events.average_entry_score`. This function owns no alternate score
 * source: a successful refresh is one complete core publication, so all
 * consumers continue to see one coherent bootstrap revision.
 */
export async function ensureLiveAverageReadyForPublication(
  season: FplSeasonRef,
  eventId: number,
  lifecycleState: LiveLifecycleState | null | undefined,
  now = new Date(),
): Promise<LiveAverageRefreshResult> {
  const periodicRefreshWindow =
    lifecycleState === 'LIVE_ACTIVE' ||
    lifecycleState === 'BETWEEN_FIXTURES' ||
    lifecycleState === 'DAY_SETTLING' ||
    lifecycleState === 'GW_REVIEW';
  const finalRefresh = lifecycleState === 'FINALIZED';
  if (!periodicRefreshWindow && !finalRefresh) {
    return {
      ready: true,
      refreshed: false,
      reason: 'outside-refresh-window',
      sourceCheckedAt: null,
    };
  }

  let redis: Awaited<ReturnType<typeof redisSingleton.getClient>>;
  let finalizationAt: string | null = null;
  try {
    if (finalRefresh) {
      finalizationAt = await eventRepository.findDataCheckedAtExact(season, eventId);
      if (finalizationAt === null) {
        return {
          ready: false,
          refreshed: false,
          reason: 'finalization-boundary-unavailable',
          sourceCheckedAt: null,
        };
      }
    }
    redis = await redisSingleton.getClient();
    if (finalRefresh) {
      const marker = await redis.get(finalRefreshKey(season.seasonCode, eventId));
      if (marker !== null) {
        const current = await readFreshCoreSource(season.seasonCode, now);
        if (
          finalAverageRefreshMarkerMatches(marker, current, finalizationAt) &&
          (await hasCanonicalAverageEntryScore(season, eventId))
        ) {
          return {
            ready: true,
            refreshed: false,
            reason: 'final-refresh-complete',
            sourceCheckedAt: current.sourceCheckedAt,
          };
        }
      }
    }
  } catch (error) {
    logError('Live Average Team refresh coordination unavailable', error, {
      season: season.seasonCode,
      eventId,
    });
    return {
      ready: false,
      refreshed: false,
      reason: 'core-unavailable',
      sourceCheckedAt: null,
    };
  }

  let current: FreshCoreSource;
  try {
    current = await readFreshCoreSource(season.seasonCode, now);
  } catch (error) {
    logError('Live Average Team core freshness read failed', error, {
      season: season.seasonCode,
      eventId,
    });
    return {
      ready: false,
      refreshed: false,
      reason: 'core-unavailable',
      sourceCheckedAt: null,
    };
  }
  if (!finalRefresh && current.fresh) {
    return {
      ready: true,
      refreshed: false,
      reason: 'fresh',
      sourceCheckedAt: current.sourceCheckedAt,
    };
  }

  const lockKey = refreshLockKey(season.seasonCode);
  const lockToken = randomUUID();
  const acquired =
    (await redis.set(lockKey, lockToken, 'PX', String(LIVE_AVERAGE_REFRESH_LOCK_TTL_MS), 'NX')) ===
    'OK';
  if (!acquired) {
    try {
      const afterLock = await readFreshCoreSource(season.seasonCode, now);
      const finalMarker = finalRefresh
        ? await redis.get(finalRefreshKey(season.seasonCode, eventId))
        : null;
      if (
        afterLock.fresh &&
        (!finalRefresh || finalAverageRefreshMarkerMatches(finalMarker, afterLock, finalizationAt))
      ) {
        return {
          ready: true,
          refreshed: false,
          reason: finalRefresh ? 'final-refresh-complete' : 'fresh',
          sourceCheckedAt: afterLock.sourceCheckedAt,
        };
      }
    } catch (error) {
      logError('Live Average Team core freshness reread failed', error, {
        season: season.seasonCode,
        eventId,
      });
    }
    return {
      ready: false,
      refreshed: false,
      reason: 'refresh-in-flight',
      sourceCheckedAt: current.sourceCheckedAt,
    };
  }

  try {
    await syncCoreSnapshot(season, {
      trigger: 'queue',
      sourceRunId: randomUUID(),
    });
    const afterRefresh = await readFreshCoreSource(season.seasonCode, new Date());
    if (!afterRefresh.fresh) {
      return {
        ready: false,
        refreshed: true,
        reason: 'refresh-failed',
        sourceCheckedAt: afterRefresh.sourceCheckedAt,
      };
    }
    if (!(await hasCanonicalAverageEntryScore(season, eventId))) {
      return {
        ready: false,
        refreshed: true,
        reason: 'average-unavailable',
        sourceCheckedAt: afterRefresh.sourceCheckedAt,
      };
    }
    if (finalRefresh) {
      const markerFinalizationAt = finalizationAt;
      const coreRevision = afterRefresh.revision;
      const corePublicationId = afterRefresh.publicationId;
      const sourceCheckedAt = afterRefresh.sourceCheckedAt;
      if (
        markerFinalizationAt === null ||
        coreRevision === null ||
        corePublicationId === null ||
        sourceCheckedAt === null
      ) {
        return {
          ready: false,
          refreshed: true,
          reason: 'refresh-failed',
          sourceCheckedAt,
        };
      }
      await redis.set(
        finalRefreshKey(season.seasonCode, eventId),
        JSON.stringify({
          finalizationAt: markerFinalizationAt,
          coreRevision,
          corePublicationId,
          sourceCheckedAt,
        } satisfies FinalAverageRefreshMarker),
        'EX',
        String(LIVE_AVERAGE_FINAL_REFRESH_TTL_SECONDS),
      );
    }
    logInfo('Live Average Team core refresh completed before H2H publication', {
      season: season.seasonCode,
      eventId,
      sourceCheckedAt: afterRefresh.sourceCheckedAt,
    });
    return {
      ready: true,
      refreshed: true,
      reason: finalRefresh ? 'final-refresh-complete' : 'refresh-complete',
      sourceCheckedAt: afterRefresh.sourceCheckedAt,
    };
  } catch (error) {
    logError('Live Average Team core refresh failed before H2H publication', error, {
      season: season.seasonCode,
      eventId,
    });
    return {
      ready: false,
      refreshed: false,
      reason: 'refresh-failed',
      sourceCheckedAt: current.sourceCheckedAt,
    };
  } finally {
    await releaseRefreshLock(lockKey, lockToken).catch((error) => {
      logError('Live Average Team core refresh lock release failed', error, {
        season: season.seasonCode,
        eventId,
      });
    });
  }
}
