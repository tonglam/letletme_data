import { closeSync, openSync, utimesSync } from 'node:fs';

/**
 * Worker liveness heartbeat.
 *
 * The worker process touches a heartbeat file on a fixed interval; Docker's
 * healthcheck (`find /tmp/worker-heartbeat -mmin -2`) treats a stale file as a
 * hung worker (event loop blocked, worker stuck) even when the process is
 * still alive. The file lives in the container's /tmp, never on a volume.
 */

export const DEFAULT_WORKER_HEARTBEAT_PATH = '/tmp/worker-heartbeat';
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Touch the heartbeat file, creating it when missing. Throws when the path is
 * not writable — callers running on an interval must catch (heartbeat must
 * never crash the worker).
 */
export function touchWorkerHeartbeat(
  path: string = DEFAULT_WORKER_HEARTBEAT_PATH,
  now: Date = new Date(),
): void {
  try {
    utimesSync(path, now, now);
  } catch {
    closeSync(openSync(path, 'w'));
  }
}

export interface WorkerHeartbeatOptions {
  path?: string;
  intervalMs?: number;
}

/**
 * Touch immediately, then every `intervalMs`. Returns a stop function for
 * graceful shutdown. Interval errors are swallowed so a transient fs failure
 * cannot kill the worker; the healthcheck catches a permanently broken touch.
 */
export function startWorkerHeartbeat(options: WorkerHeartbeatOptions = {}): () => void {
  const path = options.path ?? process.env.WORKER_HEARTBEAT_PATH ?? DEFAULT_WORKER_HEARTBEAT_PATH;
  const intervalMs =
    options.intervalMs ??
    Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS);

  touchWorkerHeartbeat(path);
  const timer = setInterval(() => {
    try {
      touchWorkerHeartbeat(path);
    } catch {
      // Heartbeat failure must never crash the worker loop.
    }
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
