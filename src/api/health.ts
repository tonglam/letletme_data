import { redisSingleton } from '../cache/singleton';
import { databaseSingleton } from '../db/singleton';
import { queueRedisSingleton } from '../queues/redis';
import { seasonRepository } from '../repositories/seasons';
import { getConfig, isBugReportScreenshotStorageConfigured } from '../utils/config';
import { checkRuntimeHeartbeat } from '../utils/runtime-heartbeat';
import { readActiveDataPublication } from '../cache/data-publication';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { loadDataPublicationDelivery } from '../repositories/data-publication-outbox';
import { eventRepository } from '../repositories/events';

export type ReadinessResult = {
  ready: boolean;
  dependencies: {
    postgres: boolean;
    cacheRedis: boolean;
    queueRedis: boolean;
    managerLiveQueue: boolean;
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

const managerLiveQueueProbe: DependencyProbe = async () => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const { managerLiveQueue } = await import('../queues/manager-live.queue');
  try {
    await Promise.race([
      managerLiveQueue.getJobCounts('waiting', 'active', 'delayed'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Manager live queue readiness timed out after 5000ms')),
          5_000,
        );
      }),
    ]);
    return true;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const activeSeasonProbe: DependencyProbe = async () => {
  const season = await seasonRepository.findCurrent();
  return /^\d{4}$/.test(season.seasonCode);
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
    { dataset: 'fpl:core' as const, seasonCode: season.seasonCode },
    { dataset: 'fpl:market' as const, seasonCode: season.seasonCode },
    ...(currentEvent
      ? [{ dataset: 'fpl:live' as const, seasonCode: season.seasonCode, eventId: currentEvent.id }]
      : []),
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
    managerLiveQueue: DependencyProbe;
    activeSeason: DependencyProbe;
    screenshotRetentionConfigured: DependencyProbe;
    scheduler: DependencyProbe;
    queueWorker: DependencyProbe;
    contentWorker: DependencyProbe;
    mediaWorker: DependencyProbe;
    publicationConsistency: DependencyProbe;
    probeTimeoutMs: number;
  }>,
): Promise<ReadinessResult> {
  const includeRuntimeDependencies =
    probes === undefined ||
    ['scheduler', 'queueWorker', 'contentWorker', 'mediaWorker', 'publicationConsistency'].some(
      (key) => Object.prototype.hasOwnProperty.call(probes, key),
    );
  const configured = {
    postgres: postgresProbe,
    cacheRedis: cacheRedisProbe,
    queueRedis: queueRedisProbe,
    managerLiveQueue: managerLiveQueueProbe,
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
  const [
    postgres,
    cacheRedis,
    queueRedis,
    managerLiveQueueHealthy,
    activeSeason,
    screenshotRetentionConfigured,
  ] = await Promise.all([
    safeProbe(configured.postgres, probeTimeoutMs),
    safeProbe(configured.cacheRedis, probeTimeoutMs),
    safeProbe(configured.queueRedis, probeTimeoutMs),
    safeProbe(configured.managerLiveQueue, probeTimeoutMs),
    safeProbe(configured.activeSeason, probeTimeoutMs),
    safeProbe(configured.screenshotRetentionConfigured, probeTimeoutMs),
  ]);
  const baseDependencies = {
    postgres,
    cacheRedis,
    queueRedis,
    managerLiveQueue: managerLiveQueueHealthy,
    activeSeason,
    screenshotRetentionConfigured,
  };
  if (!includeRuntimeDependencies) {
    return {
      ready:
        postgres &&
        cacheRedis &&
        queueRedis &&
        managerLiveQueueHealthy &&
        activeSeason &&
        screenshotRetentionConfigured,
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
    ready:
      postgres &&
      cacheRedis &&
      queueRedis &&
      managerLiveQueueHealthy &&
      activeSeason &&
      screenshotRetentionConfigured &&
      scheduler &&
      queueWorker &&
      contentWorker &&
      mediaWorker &&
      publicationConsistency,
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
