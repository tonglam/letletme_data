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
    const controller = createShutdownController({
      timeoutMs: 10,
      waitForInFlight: () => new Promise<void>(() => undefined),
      exit: (code) => exits.push(code),
    });

    await expect(controller.request('SIGTERM')).resolves.toMatchObject({ status: 'timed_out' });
    expect(exits).toEqual([1]);
  });
});
