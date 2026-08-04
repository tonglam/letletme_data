import { describe, expect, test } from 'bun:test';

import type { FPLBootstrapResponse } from '../../src/clients/fpl';
import {
  evaluateLaunchMonitor,
  LAUNCH_MONITOR_CRON_PATTERN,
  type LaunchMonitorDependencies,
} from '../../src/jobs/launch.jobs';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{ key: string; args: Array<string | number> }> = [];
  private markerFailuresRemaining: number;
  private releaseFailuresRemaining: number;
  private readonly persistResult: number | null;

  constructor(markerFailures = 0, options?: { releaseFailures?: number; persistResult?: number }) {
    this.markerFailuresRemaining = markerFailures;
    this.releaseFailuresRemaining = options?.releaseFailures ?? 0;
    this.persistResult = options?.persistResult ?? null;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<string | null> {
    this.setCalls.push({ key, args });
    if (args.includes('NX') && this.values.has(key)) return null;
    if (!key.endsWith(':lock') && this.markerFailuresRemaining > 0) {
      this.markerFailuresRemaining -= 1;
      throw new Error('marker storage unavailable');
    }
    this.values.set(key, value);
    return 'OK';
  }

  async eval(script: string, _numberOfKeys: number, key: string, token: string) {
    if (this.values.get(key) !== token) return 0;
    if (script.includes('persist')) return this.persistResult ?? 1;
    if (this.releaseFailuresRemaining > 0) {
      this.releaseFailuresRemaining -= 1;
      throw new Error('lock cleanup unavailable');
    }
    this.values.delete(key);
    return 1;
  }
}

function bootstrap(events: Array<{ id: number; deadline_time: string | null }>) {
  return { events } as unknown as FPLBootstrapResponse;
}

function dependencies(options?: {
  events?: Array<{ id: number; deadline_time: string | null }>;
  redis?: FakeRedis;
  send?: (message: string) => Promise<void>;
  delivery?: 'sent' | 'skipped';
  onBootstrap?: () => void;
}): LaunchMonitorDependencies {
  return {
    getBootstrap: async () => {
      options?.onBootstrap?.();
      return bootstrap(options?.events ?? []);
    },
    getRedis: async () => options?.redis ?? new FakeRedis(),
    sendNotification: async (message) => {
      await options?.send?.(message);
      return options?.delivery ?? 'sent';
    },
    now: () => new Date('2026-08-04T00:00:00.000Z'),
    createLockToken: () => 'lock-token',
    wait: async () => undefined,
  };
}

describe('launch monitor', () => {
  test('uses one five-minute schedule and one bootstrap request per tick', async () => {
    expect(LAUNCH_MONITOR_CRON_PATTERN).toBe('*/5 * * * *');
    const redis = new FakeRedis();
    let bootstrapCalls = 0;
    let sends = 0;
    const deps = dependencies({
      redis,
      onBootstrap: () => {
        bootstrapCalls += 1;
      },
      send: async () => {
        sends += 1;
      },
    });

    for (let tick = 0; tick < 24 * 12; tick += 1) {
      await evaluateLaunchMonitor(deps);
    }

    expect(bootstrapCalls).toBe(288);
    expect(sends).toBe(1);
  });

  test('detects the happening transition from the same bootstrap response', async () => {
    const redis = new FakeRedis();
    const messages: string[] = [];
    const result = await evaluateLaunchMonitor(
      dependencies({
        redis,
        events: [{ id: 1, deadline_time: '2026-08-15T10:00:00Z' }],
        send: async (message) => {
          messages.push(message);
        },
      }),
    );

    expect(result).toMatchObject({
      outcome: 'ready',
      notification: 'happening',
      delivery: 'sent',
    });
    expect(messages).toEqual(['【NEW SEASON】ITS HAPPENING!!!']);
    expect(redis.values.has('LaunchNotification:happening:2627')).toBe(true);
  });

  test('does not mark a disabled notification as delivered and can send it later', async () => {
    const redis = new FakeRedis();
    const skipped = await evaluateLaunchMonitor(dependencies({ redis, delivery: 'skipped' }));

    expect(skipped).toMatchObject({ outcome: 'noop', delivery: 'skipped', requiredUnits: 0 });
    expect(redis.values.has('LaunchNotification:warning:2026')).toBe(false);
    expect(redis.values.has('LaunchNotification:warning:2026:lock')).toBe(false);

    let sends = 0;
    const delivered = await evaluateLaunchMonitor(
      dependencies({
        redis,
        send: async () => {
          sends += 1;
        },
      }),
    );

    expect(delivered.delivery).toBe('sent');
    expect(sends).toBe(1);
    expect(redis.values.has('LaunchNotification:warning:2026')).toBe(true);
  });

  test('reports ordinary monitor no-ops as zero synchronization work', async () => {
    let redisCalls = 0;
    const deps = dependencies({
      events: [{ id: 1, deadline_time: '2025-08-15T10:00:00Z' }],
    });
    deps.getRedis = async () => {
      redisCalls += 1;
      throw new Error('Redis should not be needed for an ordinary no-op');
    };
    const result = await evaluateLaunchMonitor(deps);

    expect(result).toMatchObject({
      outcome: 'noop',
      delivery: 'not_applicable',
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    });
    expect(redisCalls).toBe(0);
  });

  test('serializes concurrent ticks so only one notification is delivered', async () => {
    const redis = new FakeRedis();
    let sends = 0;
    let releaseSend: () => void = () => undefined;
    let markSendStarted: () => void = () => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const deps = dependencies({
      redis,
      send: async () => {
        sends += 1;
        markSendStarted();
        await sendReleased;
      },
    });

    const first = evaluateLaunchMonitor(deps);
    await sendStarted;
    const second = await evaluateLaunchMonitor(deps);
    releaseSend();
    const firstResult = await first;

    expect(firstResult.delivery).toBe('sent');
    expect(second.delivery).toBe('locked');
    expect(sends).toBe(1);
  });

  test('uses a recoverable lease until notification delivery begins', async () => {
    const redis = new FakeRedis(0, { persistResult: 0 });
    let sends = 0;

    const result = await evaluateLaunchMonitor(
      dependencies({
        redis,
        send: async () => {
          sends += 1;
        },
      }),
    );

    expect(result.delivery).toBe('locked');
    expect(sends).toBe(0);
    expect(
      redis.setCalls.find((call) => call.key === 'LaunchNotification:warning:2026:lock')?.args,
    ).toEqual(['PX', 60_000, 'NX']);
  });

  test('retains the lock after an ambiguous delivery failure', async () => {
    const redis = new FakeRedis();
    let sends = 0;
    const deps = dependencies({
      redis,
      send: async () => {
        sends += 1;
        throw new Error('notification response lost');
      },
    });

    await expect(evaluateLaunchMonitor(deps)).rejects.toThrow('notification response lost');
    expect(redis.values.has('LaunchNotification:warning:2026:lock')).toBe(true);
    expect(redis.values.has('LaunchNotification:warning:2026')).toBe(false);

    const retry = await evaluateLaunchMonitor(deps);
    expect(retry.delivery).toBe('locked');
    expect(sends).toBe(1);
  });

  test('retries the delivered marker before releasing the notification lock', async () => {
    const redis = new FakeRedis(1);
    let sends = 0;

    const result = await evaluateLaunchMonitor(
      dependencies({
        redis,
        send: async () => {
          sends += 1;
        },
      }),
    );

    expect(result.delivery).toBe('sent');
    expect(sends).toBe(1);
    expect(redis.values.has('LaunchNotification:warning:2026')).toBe(true);
    expect(redis.values.has('LaunchNotification:warning:2026:lock')).toBe(false);
  });

  test('reports sent after marker persistence even when lock cleanup fails', async () => {
    const redis = new FakeRedis(0, { releaseFailures: 1 });
    let sends = 0;

    const result = await evaluateLaunchMonitor(
      dependencies({
        redis,
        send: async () => {
          sends += 1;
        },
      }),
    );

    expect(result.delivery).toBe('sent');
    expect(sends).toBe(1);
    expect(redis.values.has('LaunchNotification:warning:2026')).toBe(true);
  });

  test('retains the lock when delivery succeeds but every marker write fails', async () => {
    const redis = new FakeRedis(3);
    let sends = 0;
    const deps = dependencies({
      redis,
      send: async () => {
        sends += 1;
      },
    });

    await expect(evaluateLaunchMonitor(deps)).rejects.toThrow('marker storage unavailable');
    expect(redis.values.has('LaunchNotification:warning:2026')).toBe(false);
    expect(redis.values.has('LaunchNotification:warning:2026:lock')).toBe(true);
    expect(
      redis.setCalls.find((call) => call.key === 'LaunchNotification:warning:2026:lock')?.args,
    ).toEqual(['PX', 60_000, 'NX']);

    const nextTick = await evaluateLaunchMonitor(deps);
    expect(nextTick.delivery).toBe('locked');
    expect(sends).toBe(1);
  });
});
