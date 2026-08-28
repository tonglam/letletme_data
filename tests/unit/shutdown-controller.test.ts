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
      closeResources: () => {
        events.push('close');
      },
      exit: (code) => exits.push(code),
    });

    const first = controller.request('SIGTERM');
    const second = controller.request('SIGINT');
    expect(second).toBe(first);
    releaseInFlight();

    await expect(first).resolves.toMatchObject({ signal: 'SIGTERM', status: 'completed' });
    expect(events).toEqual(['stop:SIGTERM', 'wait', 'close']);
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

  test('fatal paths exit non-zero while the process is still running', () => {
    const exits: number[] = [];
    const controller = createShutdownController({ exit: (code) => exits.push(code) });

    controller.fatal(new Error('fatal worker failure'));
    controller.fatal(new Error('duplicate fatal'));

    expect(exits).toEqual([1]);
    expect(controller.isShuttingDown()).toBe(true);
  });
});
