import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKER_HEARTBEAT_PATH,
  startWorkerHeartbeat,
  touchWorkerHeartbeat,
} from '../../src/utils/worker-heartbeat';

describe('worker-heartbeat', () => {
  const tempDirs: string[] = [];
  const stoppers: Array<() => void> = [];

  afterEach(() => {
    stoppers.splice(0).forEach((stop) => stop());
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  function tempHeartbeatPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'worker-heartbeat-'));
    tempDirs.push(dir);
    return join(dir, 'heartbeat');
  }

  it('exposes the Docker-facing defaults the compose healthcheck relies on', () => {
    expect(DEFAULT_WORKER_HEARTBEAT_PATH).toBe('/tmp/worker-heartbeat');
    expect(DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it('creates the heartbeat file when missing', () => {
    const path = tempHeartbeatPath();
    expect(existsSync(path)).toBe(false);

    touchWorkerHeartbeat(path);

    expect(existsSync(path)).toBe(true);
  });

  it('updates mtime on an existing heartbeat file', () => {
    const path = tempHeartbeatPath();
    touchWorkerHeartbeat(path);

    const stale = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, stale, stale);
    expect(statSync(path).mtime.getTime()).toBe(stale.getTime());

    const now = new Date();
    touchWorkerHeartbeat(path, now);

    expect(statSync(path).mtime.getTime()).toBe(now.getTime());
  });

  it('startWorkerHeartbeat touches immediately and returns a stop function', async () => {
    const path = tempHeartbeatPath();

    const stop = startWorkerHeartbeat({ path, intervalMs: 20 });
    stoppers.push(stop);

    expect(existsSync(path)).toBe(true);
    const firstMtime = statSync(path).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(statSync(path).mtimeMs).toBeGreaterThan(firstMtime);

    stop();
    const stoppedMtime = statSync(path).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(statSync(path).mtimeMs).toBe(stoppedMtime);
  });
});
