import { redisSingleton } from '../cache/singleton';
import { getActiveCacheSeason } from '../cache/cache-season';
import { databaseSingleton } from '../db/singleton';

export type ReadinessResult = {
  ready: boolean;
  dependencies: {
    postgres: boolean;
    redis: boolean;
    activeSeason: boolean;
  };
};

type DependencyProbe = () => Promise<boolean>;

const postgresProbe: DependencyProbe = async () => {
  await databaseSingleton.connect();
  return databaseSingleton.healthCheck();
};

const redisProbe: DependencyProbe = async () => {
  await redisSingleton.connect();
  return redisSingleton.healthCheck();
};

const activeSeasonProbe: DependencyProbe = async () => /^\d{4}$/.test(await getActiveCacheSeason());

async function safeProbe(probe: DependencyProbe): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

export async function checkReadiness(
  probes: { postgres: DependencyProbe; redis: DependencyProbe; activeSeason: DependencyProbe } = {
    postgres: postgresProbe,
    redis: redisProbe,
    activeSeason: activeSeasonProbe,
  },
): Promise<ReadinessResult> {
  const [postgres, redis, activeSeason] = await Promise.all([
    safeProbe(probes.postgres),
    safeProbe(probes.redis),
    safeProbe(probes.activeSeason),
  ]);
  return {
    ready: postgres && redis && activeSeason,
    dependencies: { postgres, redis, activeSeason },
  };
}
