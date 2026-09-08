import { setTimeout as delay } from 'node:timers/promises';

function transientDatabaseError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const value = error as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      typeof value.code === 'string' &&
      (/^08[0-9A-Z]{3}$/.test(value.code) ||
        [
          '57P01',
          '57P02',
          '57P03',
          '53300',
          '40001',
          '40P01',
          'ECIRCUITBREAKER',
          'ECONNABORTED',
          'CONNECT_TIMEOUT',
          'CONNECTION_CLOSED',
          'CONNECTION_ENDED',
          'EAI_AGAIN',
          'EHOSTUNREACH',
          'ENETUNREACH',
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'EPIPE',
        ].includes(value.code))
    )
      return true;
    // Match the connection-only messages used by the existing login preflight;
    // unclassified validation and SQL errors remain terminal.
    if (
      typeof value.message === 'string' &&
      /connection terminated unexpectedly|server closed the connection unexpectedly|cannot connect now|remaining connection slots|timeout expired/i.test(
        value.message,
      )
    )
      return true;
    error = value.cause;
  }
  return false;
}

/** Retry only registry database initialization, before any acquisition worker starts. */
export async function recoverContentDatabaseStartup<T>(
  operation: () => Promise<T>,
  options: {
    signal: AbortSignal;
    onRetry: (error: unknown) => void;
    retryDelayMs?: number;
  },
): Promise<T> {
  for (;;) {
    options.signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (!transientDatabaseError(error)) throw error;
      options.signal.throwIfAborted();
      options.onRetry(error);
      await delay(options.retryDelayMs ?? 30_000, undefined, { signal: options.signal });
    }
  }
}
