import { redisSingleton } from '../cache/singleton';
import { databaseSingleton } from '../db/singleton';
import { queueRedisSingleton } from '../queues/redis';
import { seasonRepository } from '../repositories/seasons';

export type ReadinessResult = {
  ready: boolean;
  dependencies: {
    postgres: boolean;
    cacheRedis: boolean;
    queueRedis: boolean;
    activeSeason: boolean;
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
  } = {
    postgres: postgresProbe,
    cacheRedis: cacheRedisProbe,
    queueRedis: queueRedisProbe,
    activeSeason: activeSeasonProbe,
  },
): Promise<ReadinessResult> {
  const [postgres, cacheRedis, queueRedis, activeSeason] = await Promise.all([
    safeProbe(probes.postgres),
    safeProbe(probes.cacheRedis),
    safeProbe(probes.queueRedis),
    safeProbe(probes.activeSeason),
  ]);
  return {
    ready: postgres && cacheRedis && queueRedis && activeSeason,
    dependencies: { postgres, cacheRedis, queueRedis, activeSeason },
  };
}
