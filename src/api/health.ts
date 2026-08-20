import { redisSingleton } from '../cache/singleton';
import { databaseSingleton } from '../db/singleton';
import { queueRedisSingleton } from '../queues/redis';
import { seasonRepository } from '../repositories/seasons';
import { getConfig, isBugReportScreenshotStorageConfigured } from '../utils/config';

export type ReadinessResult = {
  ready: boolean;
  dependencies: {
    postgres: boolean;
    cacheRedis: boolean;
    queueRedis: boolean;
    activeSeason: boolean;
    screenshotRetentionConfigured: boolean;
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

async function safeProbe(probe: DependencyProbe): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

export async function checkReadiness(
  probes: {
    postgres: DependencyProbe;
    cacheRedis: DependencyProbe;
    queueRedis: DependencyProbe;
    activeSeason: DependencyProbe;
    screenshotRetentionConfigured: DependencyProbe;
  } = {
    postgres: postgresProbe,
    cacheRedis: cacheRedisProbe,
    queueRedis: queueRedisProbe,
    activeSeason: activeSeasonProbe,
    screenshotRetentionConfigured: screenshotRetentionConfiguredProbe,
  },
): Promise<ReadinessResult> {
  const [postgres, cacheRedis, queueRedis, activeSeason, screenshotRetentionConfigured] =
    await Promise.all([
      safeProbe(probes.postgres),
      safeProbe(probes.cacheRedis),
      safeProbe(probes.queueRedis),
      safeProbe(probes.activeSeason),
      safeProbe(probes.screenshotRetentionConfigured),
    ]);
  return {
    ready: postgres && cacheRedis && queueRedis && activeSeason && screenshotRetentionConfigured,
    dependencies: {
      postgres,
      cacheRedis,
      queueRedis,
      activeSeason,
      screenshotRetentionConfigured,
    },
  };
}
