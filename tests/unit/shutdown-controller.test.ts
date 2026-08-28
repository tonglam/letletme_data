import { describe, expect, test } from 'bun:test';

import { createShutdownController } from '../../src/utils/shutdown-controller';

describe('shared shutdown controller', () => {
  test('runs the lifecycle in order and coalesces repeated signals', async () => {
    const events: string[] = [];
    const exits: number[] = [];
    let releaseInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    const controller = createShutdownController({
      stopIntake: (signal) => {
        events.push(`stop:${signal}`);
      },
      waitForInFlight: async () => {
        events.push('wait');
        await inFlight;
      },
      closeWorkers: () => {
        events.push('workers');
      },
      closeMonitors: () => {
        events.push('monitors');
      },
      closeProducerQueues: () => {
        events.push('producers');
      },
      closeDatabase: () => {
        events.push('database');
      },
      closeCacheRedis: () => {
        events.push('cache-redis');
      },
      closeQueueRedis: () => {
        events.push('queue-redis');
      },
      closeResources: () => {
        events.push('tail');
      },
      exit: (code) => exits.push(code),
    });

    const first = controller.request('SIGTERM');
    const second = controller.request('SIGINT');
    expect(second).toBe(first);
    releaseInFlight();

    await expect(first).resolves.toMatchObject({ signal: 'SIGTERM', status: 'completed' });
    expect(events).toEqual([
      'stop:SIGTERM',
      'wait',
      'workers',
      'monitors',
      'producers',
      'database',
      'cache-redis',
      'queue-redis',
      'tail',
    ]);
    expect(exits).toEqual([0]);
    expect(controller.isShuttingDown()).toBe(true);
  });

  test('fails closed when a lifecycle stage rejects', async () => {
    const exits: number[] = [];
    const controller = createShutdownController({
      stopIntake: () => {
        throw new Error('stop failed');
      },
      closeResources: () => undefined,
      exit: (code) => exits.push(code),
    });

    await expect(controller.request('SIGTERM')).resolves.toMatchObject({ status: 'failed' });
    expect(exits).toEqual([1]);
  });

  test('returns a timeout result and exits non-zero', async () => {
    const exits: number[] = [];
    const timeoutSignals: string[] = [];
    const controller = createShutdownController({
      timeoutMs: 10,
      waitForInFlight: () => new Promise<void>(() => undefined),
      onTimeout: (signal) => {
        timeoutSignals.push(signal);
      },
      exit: (code) => exits.push(code),
    });

    await expect(controller.request('SIGTERM')).resolves.toMatchObject({ status: 'timed_out' });
    expect(exits).toEqual([1]);
    expect(timeoutSignals).toEqual(['SIGTERM']);
    expect(controller.getState()).toBe('stopped');
  });

  test('completes with optional stages absent and reports fatal errors once', async () => {
    const exits: number[] = [];
    const controller = createShutdownController({ exit: (code) => exits.push(code) });

    await expect(controller.request('SIGINT')).resolves.toMatchObject({
      signal: 'SIGINT',
      status: 'completed',
    });
    controller.fatal(new Error('late fatal')); // stopped controllers do not exit twice
    expect(exits).toEqual([0]);
    expect(controller.getState()).toBe('stopped');
  });

  test('fatal paths drain once and exit non-zero while the process is still running', async () => {
    const events: string[] = [];
    const exits: number[] = [];
    const controller = createShutdownController({
      stopIntake: () => {
        events.push('stop');
      },
      waitForInFlight: () => {
        events.push('wait');
      },
      closeDatabase: () => {
        events.push('database');
      },
      exit: (code) => exits.push(code),
    });

    const first = controller.fatal(new Error('fatal worker failure'));
    const second = controller.fatal(new Error('duplicate fatal'));

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ signal: 'FATAL', status: 'completed' });
    expect(events).toEqual(['stop', 'wait', 'database']);
    expect(exits).toEqual([1]);
    expect(controller.isShuttingDown()).toBe(true);
  });

  test('escalates a graceful signal to a non-zero exit when a fatal error arrives', async () => {
    const exits: number[] = [];
    let release!: () => void;
    const controller = createShutdownController({
      waitForInFlight: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      exit: (code) => exits.push(code),
    });

    const graceful = controller.request('SIGTERM');
    expect(controller.fatal(new Error('fatal during drain'))).toBe(graceful);
    await Promise.resolve();
    release();
    await graceful;
    expect(exits).toEqual([1]);
  });
});
