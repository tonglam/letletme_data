import { redisSingleton } from '../cache/singleton';
import { databaseSingleton } from '../db/singleton';
import { queueRedisSingleton } from '../queues/redis';
import { seasonRepository } from '../repositories/seasons';
import { getConfig, isBugReportScreenshotStorageConfigured } from '../utils/config';
import { checkRuntimeHeartbeat } from '../utils/runtime-heartbeat';
import { readActiveDataPublication } from '../cache/data-publication';
import { readLivePublicationV2 } from '../cache/live-publication-v2';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { loadDataPublicationDelivery } from '../repositories/data-publication-outbox';
import { eventRepository } from '../repositories/events';
import { readLivePublicationV2Checkpoint } from '../services/live-publication-v2-checkpoint.service';

export type ReadinessResult = {
  ready: boolean;
  dependencies: {
    postgres: boolean;
    cacheRedis: boolean;
    queueRedis: boolean;
    activeSeason: boolean;
    screenshotRetentionConfigured: boolean;
    scheduler?: boolean;
    queueWorker?: boolean;
    contentWorker?: boolean;
    mediaWorker?: boolean;
    publicationConsistency?: boolean;
  };
};

type DependencyProbe = () => Promise<boolean>;
export const READINESS_PROBE_TIMEOUT_MS = 5000;

const postgresProbe: DependencyProbe = async () => {
  await databaseSingleton.connect();
  return databaseSingleton.healthCheck();
};

const cacheRedisProbe: DependencyProbe = async () => {
  await redisSingleton.connect();
  return redisSingleton.healthCheck();
};

const queueRedisProbe: DependencyProbe = () => queueRedisSingleton.healthCheck();

let lastKnownActiveSeasonCode: string | null = null;

async function activeSeasonFromRedis(): Promise<string | null> {
  const redis = await redisSingleton.getClient();
  if (lastKnownActiveSeasonCode) {
    const active = await readActiveDataPublication({
      dataset: 'fpl:core',
      seasonCode: lastKnownActiveSeasonCode,
    }).catch(() => null);
    if (active) return lastKnownActiveSeasonCode;
  }

  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      'llm:data:fpl:core:*:active',
      'COUNT',
      '32',
    );
    cursor = nextCursor;
    for (const key of keys) {
      const match = key.match(/^llm:data:fpl:core:(\d{4}):active$/);
      if (!match) continue;
      const active = await readActiveDataPublication({
        dataset: 'fpl:core',
        seasonCode: match[1]!,
      }).catch(() => null);
      if (active) {
        lastKnownActiveSeasonCode = match[1]!;
        return lastKnownActiveSeasonCode;
      }
    }
  } while (cursor !== '0');
  return null;
}

const activeSeasonProbe: DependencyProbe = async () => {
  try {
    const season = await seasonRepository.findCurrent();
    if (/^\d{4}$/.test(season.seasonCode)) {
      lastKnownActiveSeasonCode = season.seasonCode;
      return true;
    }
  } catch {
    // Hot readiness must not disappear solely because PostgreSQL is degraded.
  }
  return (await activeSeasonFromRedis()) !== null;
};

const screenshotRetentionConfiguredProbe: DependencyProbe = async () => {
  const config = getConfig();
  return config.NODE_ENV !== 'production' || isBugReportScreenshotStorageConfigured(config);
};

const schedulerProbe: DependencyProbe = () => checkRuntimeHeartbeat('scheduler');
const queueWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('queueWorker');
const contentWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('contentWorker');
const mediaWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('mediaWorker');

const PUBLICATION_MISMATCH_GRACE_MS = 120_000;
const publicationMismatchSince = new Map<string, number>();

const publicationConsistencyProbe: DependencyProbe = async () => {
  const season = await seasonRepository.findCurrent();
  let consistent = true;
  const currentEvent = await eventRepository.findCurrent(season);
  const scopes = [
    { dataset: 'fpl:core' as const, seasonCode: season.seasonCode, eventId: undefined },
    { dataset: 'fpl:market' as const, seasonCode: season.seasonCode, eventId: undefined },
  ];
  for (const scope of scopes) {
    const key = `${scope.dataset}:${season.seasonCode}:${scope.eventId ?? ''}`;
    const dbActive = await syncOperationsRepository.findActivePublication(
      scope.dataset,
      season,
      scope.eventId,
    );
    const redisActive = await readActiveDataPublication(scope);
    const durableEvidence = dbActive
      ? await loadDataPublicationDelivery(dbActive.publicationId).catch(() => null)
      : null;
    const matches =
      Boolean(dbActive) === Boolean(durableEvidence) &&
      Boolean(dbActive) === Boolean(redisActive) &&
      (!dbActive ||
        !redisActive ||
        (dbActive.publicationId === redisActive.manifest.publicationId &&
          dbActive.revision === redisActive.manifest.revision));
    if (!matches) {
      consistent = false;
      publicationMismatchSince.set(key, publicationMismatchSince.get(key) ?? Date.now());
      continue;
    }
    publicationMismatchSince.delete(key);
  }
  const currentEventBeforeDeadline = Boolean(
    currentEvent?.deadlineTimeEpoch !== null &&
      currentEvent?.deadlineTimeEpoch !== undefined &&
      currentEvent.deadlineTimeEpoch * 1000 > Date.now(),
  );
  if (currentEvent && !currentEventBeforeDeadline) {
    const liveKey = `live-points-v2:${season.seasonCode}:${currentEvent.id}`;
    const [redisLive, checkpointLive] = await Promise.all([
      readLivePublicationV2({ season: season.seasonCode, eventId: currentEvent.id }).catch(
        () => null,
      ),
      readLivePublicationV2Checkpoint(season, currentEvent.id).catch(() => null),
    ]);
    // A Redis-first publication may legitimately be ahead of PostgreSQL while
    // its merged checkpoint obligation is pending.  Once Redis marks a
    // publication checkpointed, however, both authorities must identify the
    // same immutable generation.
    const liveMatches =
      Boolean(redisLive) &&
      redisLive !== null &&
      (redisLive.publication.checkpointedAt === null ||
        (checkpointLive !== null &&
          checkpointLive.publication.publicationId === redisLive.publication.publicationId &&
          checkpointLive.publication.generation === redisLive.publication.generation));
    if (!liveMatches) {
      consistent = false;
      publicationMismatchSince.set(liveKey, publicationMismatchSince.get(liveKey) ?? Date.now());
    } else {
      publicationMismatchSince.delete(liveKey);
    }
  }
  if (consistent) return true;
  const now = Date.now();
  return [...publicationMismatchSince.values()].every(
    (firstSeenAt) => now - firstSeenAt <= PUBLICATION_MISMATCH_GRACE_MS,
  );
};

async function safeProbe(
  probe: DependencyProbe,
  timeoutMs = READINESS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      probe(),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function checkReadiness(
  probes?: Partial<{
    postgres: DependencyProbe;
    cacheRedis: DependencyProbe;
    queueRedis: DependencyProbe;
    activeSeason: DependencyProbe;
    screenshotRetentionConfigured: DependencyProbe;
    scheduler: DependencyProbe;
    queueWorker: DependencyProbe;
    contentWorker: DependencyProbe;
    mediaWorker: DependencyProbe;
    publicationConsistency: DependencyProbe;
    includeRuntimeDependencies: boolean;
    strict: boolean;
    probeTimeoutMs: number;
  }>,
): Promise<ReadinessResult> {
  const includeRuntimeDependencies = probes?.includeRuntimeDependencies === true;
  const strict = probes?.strict === true;
  const configured = {
    postgres: postgresProbe,
    cacheRedis: cacheRedisProbe,
    queueRedis: queueRedisProbe,
    activeSeason: activeSeasonProbe,
    screenshotRetentionConfigured: screenshotRetentionConfiguredProbe,
    scheduler: schedulerProbe,
    queueWorker: queueWorkerProbe,
    contentWorker: contentWorkerProbe,
    mediaWorker: mediaWorkerProbe,
    publicationConsistency: publicationConsistencyProbe,
    ...probes,
  };
  const probeTimeoutMs = probes?.probeTimeoutMs ?? READINESS_PROBE_TIMEOUT_MS;
  const [postgres, cacheRedis, queueRedis, activeSeason, screenshotRetentionConfigured] =
    await Promise.all([
      safeProbe(configured.postgres, probeTimeoutMs),
      safeProbe(configured.cacheRedis, probeTimeoutMs),
      safeProbe(configured.queueRedis, probeTimeoutMs),
      safeProbe(configured.activeSeason, probeTimeoutMs),
      safeProbe(configured.screenshotRetentionConfigured, probeTimeoutMs),
    ]);
  const baseDependencies = {
    postgres,
    cacheRedis,
    queueRedis,
    activeSeason,
    screenshotRetentionConfigured,
  };
  if (!includeRuntimeDependencies) {
    return {
      ready: strict
        ? postgres && cacheRedis && queueRedis && activeSeason && screenshotRetentionConfigured
        : cacheRedis && activeSeason,
      dependencies: baseDependencies,
    };
  }
  const [scheduler, queueWorker, contentWorker, mediaWorker, publicationConsistency] =
    await Promise.all([
      safeProbe(configured.scheduler, probeTimeoutMs),
      safeProbe(configured.queueWorker, probeTimeoutMs),
      safeProbe(configured.contentWorker, probeTimeoutMs),
      safeProbe(configured.mediaWorker, probeTimeoutMs),
      safeProbe(configured.publicationConsistency, probeTimeoutMs),
    ]);
  return {
    ready: strict
      ? postgres &&
        cacheRedis &&
        queueRedis &&
        activeSeason &&
        screenshotRetentionConfigured &&
        scheduler &&
        queueWorker &&
        contentWorker &&
        mediaWorker &&
        publicationConsistency
      : cacheRedis && activeSeason,
    dependencies: {
      ...baseDependencies,
      scheduler,
      queueWorker,
      contentWorker,
      mediaWorker,
      publicationConsistency,
    },
  };
}
