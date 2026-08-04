import { randomUUID } from 'node:crypto';

import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { deriveSeasonFromEvents } from '../cache/cache-season';
import { redisSingleton } from '../cache/singleton';
import { fplClient, type FPLBootstrapResponse } from '../clients/fpl';
import { runDataSyncAttempt } from '../utils/data-sync-attempt';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';
import { sendTelegramMessage } from '../utils/notify';
import { CRON_TIMEZONE } from '../utils/timezone';

export const LAUNCH_MONITOR_CRON_PATTERN = '*/5 * * * *';
const NOTIFICATION_MARKER_ATTEMPTS = 3;
const NOTIFICATION_MARKER_RETRY_MS = 50;

type LaunchRedisClient = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ...args: Array<string | number>) => Promise<string | null>;
  eval: (script: string, numberOfKeys: number, ...args: string[]) => Promise<unknown>;
};

export interface LaunchMonitorDependencies {
  getBootstrap: () => Promise<FPLBootstrapResponse>;
  getRedis: () => Promise<LaunchRedisClient>;
  sendNotification: (message: string) => Promise<void>;
  now: () => Date;
  createLockToken: () => string;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface LaunchMonitorResult {
  outcome: 'ready' | 'noop';
  notification: 'warning' | 'happening' | 'none';
  delivery: 'sent' | 'already_sent' | 'locked' | 'not_applicable';
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}

const defaultDependencies: LaunchMonitorDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  getRedis: async () => (await redisSingleton.getClient()) as unknown as LaunchRedisClient,
  sendNotification: sendTelegramMessage,
  now: () => new Date(),
  createLockToken: randomUUID,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const RELEASE_LOCK_SCRIPT = [
  'if redis.call("get", KEYS[1]) == ARGV[1] then',
  '  return redis.call("del", KEYS[1])',
  'end',
  'return 0',
].join('\n');

async function releaseNotificationLock(
  redis: LaunchRedisClient,
  lockKey: string,
  token: string,
): Promise<void> {
  await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
}

async function persistNotificationMarker(
  redis: LaunchRedisClient,
  doneKey: string,
  value: string,
  dependencies: LaunchMonitorDependencies,
): Promise<void> {
  for (let attempt = 1; attempt <= NOTIFICATION_MARKER_ATTEMPTS; attempt += 1) {
    try {
      const persisted = await redis.set(doneKey, value);
      if (persisted !== 'OK') throw new Error('Launch notification marker was not persisted.');
      return;
    } catch (error) {
      if (attempt === NOTIFICATION_MARKER_ATTEMPTS) throw error;
      await (dependencies.wait ?? defaultDependencies.wait)?.(
        NOTIFICATION_MARKER_RETRY_MS * attempt,
      );
    }
  }
}

async function sendLaunchNotificationOnce(
  redis: LaunchRedisClient,
  doneKey: string,
  message: string,
  dependencies: LaunchMonitorDependencies,
): Promise<LaunchMonitorResult['delivery']> {
  if (await redis.get(doneKey)) return 'already_sent';

  const lockKey = `${doneKey}:lock`;
  const token = dependencies.createLockToken();
  // This once-per-transition side effect spans Telegram and Redis, so there is
  // no atomic commit. Keep the lock without an expiry: confirmed pre-delivery
  // failures release it, while an ambiguous delivered-without-marker state
  // remains at-most-once until an operator reconciles it.
  const acquired = await redis.set(lockKey, token, 'NX');
  if (acquired !== 'OK') return 'locked';

  let deliveryError: unknown;
  let notificationDelivered = false;
  let markerPersisted = false;
  try {
    if (await redis.get(doneKey)) return 'already_sent';
    await dependencies.sendNotification(message);
    notificationDelivered = true;
    await persistNotificationMarker(redis, doneKey, dependencies.now().toISOString(), dependencies);
    markerPersisted = true;
    return 'sent';
  } catch (error) {
    deliveryError = error;
    throw error;
  } finally {
    if (notificationDelivered && !markerPersisted) {
      logError(
        'Launch notification was delivered but its marker was not persisted; retaining lock',
        deliveryError,
      );
    } else {
      try {
        await releaseNotificationLock(redis, lockKey, token);
      } catch (error) {
        logError('Failed to release launch notification lock', error);
        if (deliveryError === undefined) throw error;
      }
    }
  }
}

function result(
  notification: LaunchMonitorResult['notification'],
  delivery: LaunchMonitorResult['delivery'],
): LaunchMonitorResult {
  const sent = delivery === 'sent';
  return {
    outcome: sent ? 'ready' : 'noop',
    notification,
    delivery,
    requiredUnits: sent ? 1 : 0,
    reusedUnits: 0,
    succeededUnits: sent ? 1 : 0,
    failedUnits: 0,
  };
}

export async function evaluateLaunchMonitor(
  dependencies: LaunchMonitorDependencies = defaultDependencies,
): Promise<LaunchMonitorResult> {
  const bootstrap = await dependencies.getBootstrap();
  const redis = await dependencies.getRedis();
  const now = dependencies.now();

  if (bootstrap.events.length === 0) {
    const delivery = await sendLaunchNotificationOnce(
      redis,
      `LaunchNotification:warning:${now.getFullYear()}`,
      '【NEW SEASON】WARNING! WARNING! WARNING!',
      dependencies,
    );
    if (delivery === 'sent') {
      logInfo('Pre-season warning: FPL events list is empty');
    }
    return result('warning', delivery);
  }

  const firstEvent = bootstrap.events[0];
  const publishedSeason = deriveSeasonFromEvents(bootstrap.events);
  if (!publishedSeason || !firstEvent.deadline_time?.startsWith(now.getFullYear().toString())) {
    return result('none', 'not_applicable');
  }

  const delivery = await sendLaunchNotificationOnce(
    redis,
    `LaunchNotification:happening:${publishedSeason}`,
    '【NEW SEASON】ITS HAPPENING!!!',
    dependencies,
  );
  if (delivery === 'sent') {
    logInfo('New season detected: first event deadline is published', {
      deadlineTime: firstEvent.deadline_time,
      publishedSeason,
    });
  }
  return result('happening', delivery);
}

export async function runLaunchMonitor(options?: {
  source?: 'cron' | 'manual';
  runId?: string;
  dependencies?: LaunchMonitorDependencies;
}): Promise<LaunchMonitorResult> {
  const source = options?.source ?? 'manual';
  const now = options?.dependencies?.now() ?? new Date();
  return runDataSyncAttempt(
    {
      queue: 'cron',
      jobName: 'launch-monitor',
      runId: options?.runId ?? `launch-monitor-${now.getTime()}`,
      source,
    },
    () => evaluateLaunchMonitor(options?.dependencies),
  );
}

export function registerLaunchJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'launch-monitor',
      pattern: LAUNCH_MONITOR_CRON_PATTERN,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('launch-monitor', async () => {
            await runLaunchMonitor({ source: 'cron' });
          });
        } catch {
          // Failure details are already emitted by runTrackedJob and the attempt report.
        }
      },
    }),
  );
}
