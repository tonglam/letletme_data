import { pipe } from 'fp-ts/function';
import * as IOE from 'fp-ts/IOEither';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import Redis, { ChainableCommander } from 'ioredis';
import {
  CacheError,
  CacheErrorType,
  ConnectionStatus,
  DEFAULT_POOL_CONFIG,
  PoolConfig,
  PoolState,
  RedisClient,
  RedisConfig,
} from '../types';

// Error handling
const createError = (type: CacheErrorType, message: string, cause?: unknown): CacheError => ({
  type,
  message,
  cause: cause instanceof Error ? cause : new Error(String(cause)),
});

// Redis operation wrapper
const wrapRedisOperation = <T>(
  operation: () => Promise<T>,
  errorType: CacheErrorType,
  errorMessage: string,
): TE.TaskEither<CacheError, T> =>
  TE.tryCatch(operation, (error) => createError(errorType, errorMessage, error));

// Create connection status handler
const createConnectionHandler = () => {
  const state = { status: O.none as O.Option<boolean> };
  return {
    getStatus: (): ConnectionStatus => state.status,
    setConnected: (): void => {
      state.status = O.some(true);
    },
    setDisconnected: (): void => {
      state.status = O.some(false);
    },
  };
};

// Create connection pool
const createConnectionPool = (
  config: RedisConfig,
  poolConfig: PoolConfig = DEFAULT_POOL_CONFIG,
) => {
  const state: PoolState = {
    connections: [],
    activeConnections: new Set(),
  };

  const acquire = (): TE.TaskEither<CacheError, Redis> =>
    TE.tryCatch(
      async () => {
        const available = state.connections.find((conn) => !state.activeConnections.has(conn));
        if (available) {
          state.activeConnections.add(available);
          return available;
        }

        if (state.connections.length < poolConfig.maxConnections) {
          const client = new Redis(config);
          state.connections.push(client);
          state.activeConnections.add(client);
          return client;
        }

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection acquisition timeout'));
          }, poolConfig.acquireTimeout);

          const checkAvailable = () => {
            const conn = state.connections.find((c) => !state.activeConnections.has(c));
            if (conn) {
              clearTimeout(timeout);
              state.activeConnections.add(conn);
              resolve(conn);
            } else {
              setTimeout(checkAvailable, 100);
            }
          };

          checkAvailable();
        });
      },
      (error) => createError(CacheErrorType.CONNECTION, 'Failed to acquire connection', error),
    );

  const release = (client: Redis): TE.TaskEither<CacheError, void> =>
    TE.tryCatch(
      () => {
        state.activeConnections.delete(client);
        return Promise.resolve();
      },
      (error) => createError(CacheErrorType.CONNECTION, 'Failed to release connection', error),
    );

  const shutdown = (): TE.TaskEither<CacheError, void> =>
    TE.tryCatch(
      async () => {
        await Promise.all(state.connections.map((conn) => conn.quit()));
        state.connections.length = 0;
        state.activeConnections.clear();
      },
      (error) =>
        createError(CacheErrorType.CONNECTION, 'Failed to shutdown connection pool', error),
    );

  return {
    acquire,
    release,
    shutdown,
  };
};

// Modify createRedisClient to use functional connection pool
export const createRedisClient = (config: RedisConfig): IOE.IOEither<CacheError, RedisClient> =>
  pipe(
    IOE.tryCatch(
      () => {
        const pool = createConnectionPool(config);
        const connectionHandler = createConnectionHandler();

        return {
          connect: () =>
            pipe(
              pool.acquire(),
              TE.chain((client) => {
                client.on('connect', () => connectionHandler.setConnected());
                client.on('error', () => connectionHandler.setDisconnected());
                client.on('close', () => {
                  connectionHandler.setDisconnected();
                  pipe(pool.release(client), TE.toUnion)();
                });
                return TE.right(undefined);
              }),
            ),

          disconnect: () => pool.shutdown(),

          get: (key: string) =>
            pipe(
              pool.acquire(),
              TE.chain((client) =>
                pipe(
                  wrapRedisOperation(
                    () => client.get(key),
                    CacheErrorType.OPERATION,
                    `Failed to get value for key: ${key}`,
                  ),
                  TE.map(O.fromNullable),
                  TE.chainFirst(() => pool.release(client)),
                ),
              ),
            ),

          set: (key: string, value: string, ttl?: number) =>
            pipe(
              pool.acquire(),
              TE.chain((client) =>
                pipe(
                  wrapRedisOperation(
                    () => (ttl ? client.set(key, value, 'EX', ttl) : client.set(key, value)),
                    CacheErrorType.OPERATION,
                    `Failed to set value for key: ${key}`,
                  ),
                  TE.chainFirst(() => pool.release(client)),
                  TE.map(() => undefined),
                ),
              ),
            ),

          del: (...keys: readonly string[]) =>
            pipe(
              pool.acquire(),
              TE.chain((client) =>
                pipe(
                  wrapRedisOperation(
                    () => client.del(...keys),
                    CacheErrorType.OPERATION,
                    `Failed to delete keys: ${keys.join(', ')}`,
                  ),
                  TE.chainFirst(() => pool.release(client)),
                ),
              ),
            ),

          keys: (pattern: string) =>
            pipe(
              pool.acquire(),
              TE.chain((client) =>
                pipe(
                  wrapRedisOperation(
                    () => client.keys(pattern),
                    CacheErrorType.OPERATION,
                    `Failed to get keys for pattern: ${pattern}`,
                  ),
                  TE.chainFirst(() => pool.release(client)),
                ),
              ),
            ),

          multi: () =>
            pipe(
              pool.acquire(),
              TE.chain((client) =>
                pipe(
                  wrapRedisOperation(
                    async () => client.multi(),
                    CacheErrorType.OPERATION,
                    'Failed to create transaction',
                  ),
                  TE.chainFirst(() => pool.release(client)),
                ),
              ),
            ),

          exec: (multi: ChainableCommander) =>
            pipe(
              pool.acquire(),
              TE.chain((client) =>
                pipe(
                  wrapRedisOperation(
                    async () => {
                      const result = await multi.exec();
                      return (
                        result?.map(([error, value]: [Error | null, unknown]) => {
                          if (error) throw error;
                          return value;
                        }) ?? []
                      );
                    },
                    CacheErrorType.OPERATION,
                    'Failed to execute transaction',
                  ),
                  TE.chainFirst(() => pool.release(client)),
                ),
              ),
            ),

          ping: () =>
            pipe(
              pool.acquire(),
              TE.chain((client) =>
                pipe(
                  wrapRedisOperation(
                    () => client.ping(),
                    CacheErrorType.OPERATION,
                    'Failed to ping Redis server',
                  ),
                  TE.chainFirst(() => pool.release(client)),
                ),
              ),
            ),

          isReady: () =>
            pipe(
              connectionHandler.getStatus(),
              O.getOrElse(() => false),
            ),
        };
      },
      (error) => createError(CacheErrorType.CONNECTION, 'Failed to create Redis client', error),
    ),
  );
