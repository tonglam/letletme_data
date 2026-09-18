import { randomUUID } from 'node:crypto';

import { readCoreSnapshotLifecycle } from '../cache/core-snapshot-cache';
import { redisSingleton } from '../cache/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { syncCoreSnapshot } from './core-snapshot.service';
import type { LiveLifecycleState } from './live-lifecycle-orchestrator';
import { logError, logInfo } from '../utils/logger';

/**
 * Average Team is a bootstrap/core fact. Refresh it only while a fixture is
 * active, and at a deliberately lower cadence than the 30-second event-live
 * publication. Between fixtures and after settlement keep the last accepted
 * core publication; the next active fixture will refresh it if necessary.
 */
export const LIVE_AVERAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const LIVE_AVERAGE_REFRESH_LOCK_TTL_MS = 120_000;

export type LiveAverageRefreshResult = Readonly<{
  ready: boolean;
  refreshed: boolean;
  reason:
    | 'not-live-active'
    | 'fresh'
    | 'refresh-complete'
    | 'refresh-in-flight'
    | 'core-unavailable'
    | 'refresh-failed';
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

async function readFreshCoreSource(
  seasonCode: string,
  now: Date,
): Promise<{ fresh: boolean; sourceCheckedAt: string | null }> {
  const lifecycle = await readCoreSnapshotLifecycle(seasonCode);
  const sourceCheckedAt = lifecycle?.manifest.sourceCheckedAt ?? null;
  return {
    fresh: !shouldRefreshLiveAverage(sourceCheckedAt, now),
    sourceCheckedAt,
  };
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
  if (lifecycleState !== 'LIVE_ACTIVE') {
    return {
      ready: true,
      refreshed: false,
      reason: 'not-live-active',
      sourceCheckedAt: null,
    };
  }

  let current: { fresh: boolean; sourceCheckedAt: string | null };
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
  if (current.fresh) {
    return {
      ready: true,
      refreshed: false,
      reason: 'fresh',
      sourceCheckedAt: current.sourceCheckedAt,
    };
  }

  let redis: Awaited<ReturnType<typeof redisSingleton.getClient>>;
  try {
    redis = await redisSingleton.getClient();
  } catch (error) {
    logError('Live Average Team refresh lock unavailable', error, {
      season: season.seasonCode,
      eventId,
    });
    return {
      ready: false,
      refreshed: false,
      reason: 'core-unavailable',
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
      if (afterLock.fresh) {
        return {
          ready: true,
          refreshed: false,
          reason: 'fresh',
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
    logInfo('Live Average Team core refresh completed before H2H publication', {
      season: season.seasonCode,
      eventId,
      sourceCheckedAt: afterRefresh.sourceCheckedAt,
    });
    return {
      ready: true,
      refreshed: true,
      reason: 'refresh-complete',
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
