import { redisSingleton } from '../cache/singleton';
import { databaseSingleton } from '../db/singleton';
import { queueRedisSingleton } from '../queues/redis';
import { seasonRepository } from '../repositories/seasons';
import { getConfig, isBugReportScreenshotStorageConfigured } from '../utils/config';
import { checkRuntimeHeartbeat } from '../utils/runtime-heartbeat';
import { readActiveDataPublication } from '../cache/data-publication';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { eventRepository } from '../repositories/events';

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
    publicationConsistency?: boolean;
  };
};

type DependencyProbe = () => Promise<boolean>;

const postgresProbe: DependencyProbe = async () => {
  await databaseSingleton.connect();
  return databaseSingleton.healthCheck();
};

const cacheRedisProbe: DependencyProbe = async () => {
  await redisSingleton.connect();
  return redisSingleton.healthCheck();
};

const queueRedisProbe: DependencyProbe = () => queueRedisSingleton.healthCheck();

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
    const matches =
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

async function safeProbe(probe: DependencyProbe): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
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
    publicationConsistency: DependencyProbe;
  }>,
): Promise<ReadinessResult> {
  const includeRuntimeDependencies =
    probes === undefined ||
    ['scheduler', 'queueWorker', 'contentWorker', 'publicationConsistency'].some((key) =>
      Object.prototype.hasOwnProperty.call(probes, key),
    );
  const configured = {
    postgres: postgresProbe,
    cacheRedis: cacheRedisProbe,
    queueRedis: queueRedisProbe,
    activeSeason: activeSeasonProbe,
    screenshotRetentionConfigured: screenshotRetentionConfiguredProbe,
    scheduler: schedulerProbe,
    queueWorker: queueWorkerProbe,
    contentWorker: contentWorkerProbe,
    publicationConsistency: publicationConsistencyProbe,
    ...probes,
  };
  const [postgres, cacheRedis, queueRedis, activeSeason, screenshotRetentionConfigured] =
    await Promise.all([
      safeProbe(configured.postgres),
      safeProbe(configured.cacheRedis),
      safeProbe(configured.queueRedis),
      safeProbe(configured.activeSeason),
      safeProbe(configured.screenshotRetentionConfigured),
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
      ready: postgres && cacheRedis && queueRedis && activeSeason && screenshotRetentionConfigured,
      dependencies: baseDependencies,
    };
  }
  const [scheduler, queueWorker, contentWorker, publicationConsistency] = await Promise.all([
    safeProbe(configured.scheduler),
    safeProbe(configured.queueWorker),
    safeProbe(configured.contentWorker),
    safeProbe(configured.publicationConsistency),
  ]);
  return {
    ready:
      postgres &&
      cacheRedis &&
      queueRedis &&
      activeSeason &&
      screenshotRetentionConfigured &&
      scheduler &&
      queueWorker &&
      contentWorker &&
      publicationConsistency,
    dependencies: {
      ...baseDependencies,
      scheduler,
      queueWorker,
      contentWorker,
      publicationConsistency,
    },
  };
}
