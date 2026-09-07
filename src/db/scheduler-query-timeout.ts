import type postgres from 'postgres';

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
        const timer = setTimeout(() => query.cancel(), timeoutMs);
        pending = query.then(
          (rows) => {
            clearTimeout(timer);
            return rows;
          },
          (error: unknown) => {
            clearTimeout(timer);
            throw error;
          },
        );
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
          Reflect.apply(
            value,
            target,
            args.map((arg) =>
              typeof arg === 'function'
                ? (transaction: postgres.TransactionSql) =>
                    arg(withSchedulerQueryTimeout(transaction, timeoutMs))
                : arg,
            ),
          );
      }
      if (property === 'unsafe' || property === 'file') {
        return (...args: unknown[]) => queryResult(Reflect.apply(value, target, args));
      }
      return value.bind(target);
    },
  });
}
