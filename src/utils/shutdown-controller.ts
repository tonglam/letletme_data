import { logError, logInfo } from './logger';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export type ShutdownControllerOptions = Readonly<{
  timeoutMs?: number;
  stopIntake?: (signal: string) => void | Promise<void>;
  waitForInFlight?: () => void | Promise<void>;
  closeResources?: () => void | Promise<void>;
  exit?: (code: number) => void;
  onTimeout?: (signal: string) => void | Promise<void>;
}>;

export type ShutdownResult = Readonly<{
  signal: string;
  status: 'completed' | 'failed' | 'timed_out';
  error?: unknown;
}>;

type ShutdownState = 'running' | 'stopping' | 'stopped';

/**
 * Coordinates process shutdown in one predictable, idempotent sequence.
 *
 * The controller deliberately accepts lifecycle callbacks rather than knowing
 * about BullMQ, HTTP servers, or database clients.  Each runtime can therefore
 * stop accepting work first, drain its own work, and finally close all clients
 * without duplicating signal races or timeout handling.
 */
export function createShutdownController(options: ShutdownControllerOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let state: ShutdownState = 'running';
  let inFlight: Promise<ShutdownResult> | null = null;
  let exitCalled = false;

  const exit = (code: number): void => {
    if (exitCalled) return;
    exitCalled = true;
    (options.exit ?? ((value: number) => process.exit(value)))(code);
  };

  const runStage = async (
    name: string,
    callback: (() => void | Promise<void>) | undefined,
  ): Promise<unknown | null> => {
    if (!callback) return null;
    try {
      await callback();
      return null;
    } catch (error) {
      logError(`Shutdown ${name} stage failed`, error);
      return error;
    }
  };

  const request = (signal: string, exitCode = 0): Promise<ShutdownResult> => {
    if (inFlight) return inFlight;
    state = 'stopping';

    const sequence = (async (): Promise<ShutdownResult> => {
      const errors: unknown[] = [];
      const stopIntakeError = await runStage(
        'stop-intake',
        options.stopIntake ? () => options.stopIntake?.(signal) : undefined,
      );
      if (stopIntakeError) errors.push(stopIntakeError);
      for (const [name, callback] of [
        ['wait-in-flight', options.waitForInFlight],
        ['close-resources', options.closeResources],
      ] as const) {
        const error = await runStage(name, callback);
        if (error) errors.push(error);
      }
      if (errors.length > 0) {
        return { signal, status: 'failed', error: errors[0] };
      }
      return { signal, status: 'completed' };
    })();

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(
        () => reject(new Error(`Shutdown timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    inFlight = (async (): Promise<ShutdownResult> => {
      try {
        const result = await Promise.race([sequence, timeout]);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        state = 'stopped';
        exit(result.status === 'completed' ? exitCode : 1);
        return result;
      } catch (error) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        state = 'stopped';
        logError('Shutdown did not complete within the timeout; exiting uncleanly', error, {
          signal,
          timeoutMs,
        });
        await runStage('timeout', () => options.onTimeout?.(signal));
        exit(1);
        return { signal, status: 'timed_out', error };
      }
    })();

    // The sequence continues draining after a timeout in order to give best
    // effort cleanup a chance, but it must never create an unhandled rejection.
    void sequence.catch(() => undefined);
    return inFlight;
  };

  const fatal = (error: unknown, context = 'fatal runtime error'): void => {
    if (state === 'stopped') return;
    state = 'stopping';
    logError(context, error);
    exit(1);
  };

  return {
    request,
    fatal,
    isShuttingDown: (): boolean => state !== 'running',
    getState: (): ShutdownState => state,
    getPromise: (): Promise<ShutdownResult> | null => inFlight,
  };
}

/** Convenience adapter for signal handlers shared by all long-lived runtimes. */
export function installShutdownSignals(
  controller: ReturnType<typeof createShutdownController>,
): void {
  const handle = (signal: string) => {
    logInfo('Shutdown signal received', { signal });
    void controller.request(signal);
  };
  process.on('SIGINT', () => handle('SIGINT'));
  process.on('SIGTERM', () => handle('SIGTERM'));
}
