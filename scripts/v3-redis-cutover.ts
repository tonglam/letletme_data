/* eslint-disable no-console */
import Redis from 'ioredis';

import {
  cleanupLegacyRedisKeys,
  inspectLegacyRedisQueues,
  inspectRuntimeRedisQueues,
  LEGACY_REDIS_CLEANUP_GROUPS,
  relocateLegacyRedisQueues,
  type LegacyRedisCleanupGroup,
} from '../src/cache/legacy-cleanup';
import { assertExactV3LegacyDropApproval } from './v3-legacy-drop-gate';

type RedisEndpoint = {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db: number;
};

const VALID_GROUPS = new Set<LegacyRedisCleanupGroup>(
  Object.keys(LEGACY_REDIS_CLEANUP_GROUPS) as LegacyRedisCleanupGroup[],
);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerValue(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return parsed;
}

function endpoint(prefix: 'CACHE' | 'QUEUE'): RedisEndpoint {
  return {
    host: requiredEnvironment(`${prefix}_REDIS_HOST`),
    port: integerValue(
      requiredEnvironment(`${prefix}_REDIS_PORT`),
      `${prefix}_REDIS_PORT`,
      1,
      65_535,
    ),
    password: process.env[`${prefix}_REDIS_PASSWORD`] || undefined,
    db: integerValue(requiredEnvironment(`${prefix}_REDIS_DB`), `${prefix}_REDIS_DB`, 0, 15),
  };
}

function endpointIdentity(value: RedisEndpoint): string {
  return `${value.host.toLowerCase()}:${value.port}/${value.db}`;
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function positiveOption(args: readonly string[], name: string, fallback: number): number {
  const value = optionValue(args, name);
  return value === undefined ? fallback : integerValue(value, name, 1, 1_000_000);
}

function cleanupGroups(args: readonly string[]): LegacyRedisCleanupGroup[] {
  const value = optionValue(args, '--groups');
  if (!value) throw new Error('--groups requires an explicit comma-separated cleanup group list');
  const groups = value.split(',').filter(Boolean) as LegacyRedisCleanupGroup[];
  if (groups.length === 0 || groups.some((group) => !VALID_GROUPS.has(group))) {
    throw new Error(`--groups must use only: ${[...VALID_GROUPS].join(',')}`);
  }
  if (new Set(groups).size !== groups.length) {
    throw new Error('--groups must not contain duplicates');
  }
  return groups;
}

function assertArguments(command: string | undefined, args: readonly string[]): void {
  if (
    command !== 'copy-queues' &&
    command !== 'inspect-queues' &&
    command !== 'verify-queues' &&
    command !== 'cleanup'
  ) {
    throw new Error(
      'Usage: bun run redis:cutover <copy-queues|inspect-queues|verify-queues|cleanup> [--execute] [options]',
    );
  }
  const allowedPrefixes =
    command === 'copy-queues'
      ? ['--execute', '--max-keys=']
      : command === 'inspect-queues'
        ? ['--digest-only', '--runtime-stable', '--max-keys=']
        : command === 'verify-queues'
          ? ['--runtime-stable', '--max-keys=']
          : ['--execute', '--groups=', '--max-keys=', '--unlink-batch-size='];
  const unknown = args.find(
    (argument) =>
      !allowedPrefixes.some(
        (prefix) => argument === prefix || (prefix.endsWith('=') && argument.startsWith(prefix)),
      ),
  );
  if (unknown) throw new Error(`Unknown ${command} argument: ${unknown}`);
}

function createRedisClient(value: RedisEndpoint): Redis {
  return new Redis({
    ...value,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
  });
}

function publicEndpoint(value: RedisEndpoint) {
  return { hostRecorded: false, port: value.port, db: value.db };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  assertArguments(command, args);
  const execute = args.includes('--execute');
  const maxKeys = positiveOption(args, '--max-keys', 10_000);
  const cacheEndpoint = endpoint('CACHE');
  const queueEndpoint = endpoint('QUEUE');
  if (endpointIdentity(cacheEndpoint) === endpointIdentity(queueEndpoint)) {
    throw new Error('Cache source and queue target Redis endpoints must be different');
  }

  const cacheRedis = createRedisClient(cacheEndpoint);
  const queueRedis = createRedisClient(queueEndpoint);
  try {
    await Promise.all([cacheRedis.connect(), queueRedis.connect()]);
    await Promise.all([cacheRedis.ping(), queueRedis.ping()]);

    if (command === 'inspect-queues') {
      const manifest = args.includes('--runtime-stable')
        ? await inspectRuntimeRedisQueues(queueRedis, { maxKeys })
        : await inspectLegacyRedisQueues(queueRedis, { maxKeys });
      if (args.includes('--digest-only')) {
        console.log(manifest.payloadManifestSha256);
      } else {
        console.log(
          JSON.stringify(
            {
              operation: command,
              target: publicEndpoint(queueEndpoint),
              manifest,
            },
            null,
            2,
          ),
        );
      }
      return;
    }

    if (command === 'verify-queues') {
      const manifest = args.includes('--runtime-stable')
        ? await inspectRuntimeRedisQueues(queueRedis, { maxKeys })
        : await inspectLegacyRedisQueues(queueRedis, { maxKeys });
      const expectedManifest = requiredEnvironment('V3_REDIS_QUEUE_MANIFEST_SHA256');
      if (manifest.payloadManifestSha256 !== expectedManifest) {
        throw new Error('Queue target does not match V3_REDIS_QUEUE_MANIFEST_SHA256');
      }
      console.log(
        JSON.stringify(
          {
            operation: command,
            verified: true,
            target: publicEndpoint(queueEndpoint),
            manifest,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (command === 'copy-queues') {
      const preflight = await relocateLegacyRedisQueues(cacheRedis, queueRedis, {
        dryRun: true,
        maxKeys,
      });
      if (!execute) {
        console.log(
          JSON.stringify(
            {
              operation: command,
              executed: false,
              source: publicEndpoint(cacheEndpoint),
              target: publicEndpoint(queueEndpoint),
              preflight,
            },
            null,
            2,
          ),
        );
        return;
      }

      const approvedManifest = requiredEnvironment('V3_REDIS_QUEUE_MANIFEST_SHA256');
      if (approvedManifest !== preflight.payloadManifestSha256) {
        throw new Error(
          'V3_REDIS_QUEUE_MANIFEST_SHA256 does not match the dry-run payload manifest',
        );
      }
      const execution = await relocateLegacyRedisQueues(cacheRedis, queueRedis, {
        dryRun: false,
        maxKeys,
      });
      const verification = await relocateLegacyRedisQueues(cacheRedis, queueRedis, {
        dryRun: true,
        maxKeys,
      });
      if (
        verification.pendingKeys !== 0 ||
        verification.alreadyPresentKeys !== verification.matchedKeys
      ) {
        throw new Error('Queue relocation verification did not find an exact target copy');
      }
      console.log(
        JSON.stringify(
          {
            operation: command,
            executed: true,
            source: publicEndpoint(cacheEndpoint),
            target: publicEndpoint(queueEndpoint),
            preflight,
            execution,
            verification,
          },
          null,
          2,
        ),
      );
      return;
    }

    const groups = cleanupGroups(args);
    const unlinkBatchSize = positiveOption(args, '--unlink-batch-size', 100);
    const preflight = await cleanupLegacyRedisKeys(cacheRedis, {
      groups,
      dryRun: true,
      maxKeys,
      unlinkBatchSize,
    });
    if (!execute) {
      console.log(
        JSON.stringify(
          {
            operation: command,
            executed: false,
            source: publicEndpoint(cacheEndpoint),
            preflight,
          },
          null,
          2,
        ),
      );
      return;
    }

    assertExactV3LegacyDropApproval(
      process.env.V3_LEGACY_DROP_APPROVAL,
      process.env.CUTOVER_RUN_ID,
    );
    const approvedManifest = requiredEnvironment('V3_REDIS_CLEANUP_MANIFEST_SHA256');
    if (approvedManifest !== preflight.keyManifestSha256) {
      throw new Error('V3_REDIS_CLEANUP_MANIFEST_SHA256 does not match the dry-run key manifest');
    }

    let queueRelocationVerification = null;
    if (groups.includes('legacyQueueDb0')) {
      const queueSourcePreflight = await cleanupLegacyRedisKeys(cacheRedis, {
        groups: ['legacyQueueDb0'],
        dryRun: true,
        maxKeys,
      });
      if (queueSourcePreflight.matchedKeys > 0) {
        queueRelocationVerification = await relocateLegacyRedisQueues(cacheRedis, queueRedis, {
          dryRun: true,
          maxKeys,
        });
        if (
          queueRelocationVerification.pendingKeys !== 0 ||
          queueRelocationVerification.alreadyPresentKeys !== queueRelocationVerification.matchedKeys
        ) {
          throw new Error('Legacy DB0 queues cannot be removed before exact queue relocation');
        }
      }
    }

    const execution = await cleanupLegacyRedisKeys(cacheRedis, {
      groups,
      dryRun: false,
      maxKeys,
      unlinkBatchSize,
    });
    const verification = await cleanupLegacyRedisKeys(cacheRedis, {
      groups,
      dryRun: true,
      maxKeys,
      unlinkBatchSize,
    });
    if (execution.unlinkedKeys !== execution.matchedKeys || verification.matchedKeys !== 0) {
      throw new Error('Legacy Redis cleanup verification found an incomplete unlink');
    }

    console.log(
      JSON.stringify(
        {
          operation: command,
          executed: true,
          source: publicEndpoint(cacheEndpoint),
          target: publicEndpoint(queueEndpoint),
          queueRelocationVerification,
          preflight,
          execution,
          verification,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled([cacheRedis.quit(), queueRedis.quit()]);
  }
}

main().catch((error) => {
  console.error('[v3-redis-cutover] failed', error);
  process.exitCode = 1;
});
