import type postgres from 'postgres';
import { TimeoutError } from '../utils/async';

/**
 * Request cancellation before the scheduler definition's caller deadline.
 * Promise.race alone leaves the SQL running. Keep postgres.js
 * query objects lazy (including SQL fragments and .values()), cancel only once
 * execution is requested, and await the driver's actual settlement so a
 * transaction cannot commit while its cancelled statement is still running.
 */
export function withSchedulerQueryTimeout<T extends postgres.Sql | postgres.TransactionSql>(
  client: T,
  timeoutMs: number,
): T {
  // postgres.js does not expose its queued BEGIN as a cancellable query.
  // Fence an expired acquisition before its callback can execute, and retain
  // at most one abandoned acquisition until the driver rolls it back. This
  // prevents both a hung pass and accumulating new BEGIN waiters each pass.
  // Keep scheduler work out of the driver's wire pipeline until the previous
  // operation settles. Queued deadlines can then discard work before it is
  // sent, rather than racing a cancellation against a later statement.
  const waiting: Array<() => void> = [];
  let running = false;
  function enqueueWork(operation: () => unknown) {
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolve, fail) => {
      reject = fail;
      waiting.push(() => {
        running = true;
        void Promise.resolve()
          .then(operation)
          .then(
            (value) => {
              resolve(value);
              finish();
            },
            (error: unknown) => {
              fail(error);
              finish();
            },
          );
      });
    });
    const queued = waiting.at(-1)!;
    function finish() {
      running = false;
      waiting.shift()?.();
    }
    if (!running) waiting.shift()?.();
    return {
      promise,
      cancelQueued(error: Error): boolean {
        const index = waiting.indexOf(queued);
        if (index < 0) return false;
        waiting.splice(index, 1);
        reject(error);
        return true;
      },
    };
  }
  let abandonedAcquisition: Promise<unknown> | undefined;

  function transactionCall(
    method: (...args: unknown[]) => unknown,
    args: unknown[],
  ): Promise<unknown> {
    const error = new TimeoutError('Scheduler transaction acquisition exceeded its deadline');
    if (abandonedAcquisition) return Promise.reject(error);
    let expired = false;
    let rejectDeadline!: (reason: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      expired = true;
      if (!scheduled.cancelQueued(error)) abandonedAcquisition = operation;
      rejectDeadline(error);
    }, timeoutMs);
    const scheduled = enqueueWork(() => {
      if (expired) throw error;
      return Reflect.apply(
        method,
        client,
        args.map((arg) =>
          typeof arg === 'function'
            ? (transaction: postgres.TransactionSql) => {
                clearTimeout(timer);
                if (expired) throw error;
                return arg(withSchedulerQueryTimeout(transaction, timeoutMs));
              }
            : arg,
        ),
      );
    });
    const operation = scheduled.promise;
    void operation
      .finally(() => {
        clearTimeout(timer);
        if (abandonedAcquisition === operation) abandonedAcquisition = undefined;
      })
      .catch(() => undefined);
    return Promise.race([operation, deadline]);
  }

  function queryResult(result: unknown): unknown {
    if (
      !result ||
      typeof result !== 'object' ||
      !('cancel' in result) ||
      typeof result.cancel !== 'function' ||
      !('then' in result) ||
      typeof result.then !== 'function'
    ) {
      return result;
    }
    const query = result as postgres.PendingQuery<postgres.Row[]>;
    let pending: Promise<unknown> | undefined;
    function start(): Promise<unknown> {
      if (!pending) {
        const scheduled = enqueueWork(() => query);
        const timer = setTimeout(() => {
          const error = new TimeoutError('Scheduler SQL queue wait exceeded its deadline');
          if (!scheduled.cancelQueued(error)) query.cancel();
        }, timeoutMs);
        pending = scheduled.promise.finally(() => clearTimeout(timer));
      }
      return pending;
    }
    const wrapped = new Proxy(query, {
      get(target, property) {
        if (property === 'then')
          return (...args: Parameters<Promise<unknown>['then']>) => start().then(...args);
        if (property === 'catch')
          return (...args: Parameters<Promise<unknown>['catch']>) => start().catch(...args);
        if (property === 'finally')
          return (...args: Parameters<Promise<unknown>['finally']>) => start().finally(...args);
        if (property === 'execute')
          return () => {
            void start().catch(() => undefined);
            return wrapped;
          };
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const next: unknown = Reflect.apply(value, target, args);
          return next === target ? wrapped : next;
        };
      },
    });
    return wrapped;
  }

  return new Proxy(client, {
    apply(target, thisArg, args) {
      return queryResult(Reflect.apply(target, thisArg, args));
    },
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) =>
          transactionCall(value as (...args: unknown[]) => unknown, args);
      }
      if (property === 'unsafe' || property === 'file') {
        return (...args: unknown[]) => queryResult(Reflect.apply(value, target, args));
      }
      return value.bind(target);
    },
  });
}
