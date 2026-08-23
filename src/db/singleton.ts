import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';

import { getConfig } from '../utils/config';
import { logError, logInfo } from '../utils/logger';
import { isTransactionPoolerConnection } from './postgres-connection';
import { assertDataRuntimeRole } from './runtime-role-contract';
import * as schema from './schemas/index.schema';

/**
 * A guarded mutation propagates its pinned PostgreSQL transaction through the
 * call graph. Repositories can keep their existing `getDb()`/`getDbClient()`
 * contracts while canonical writes execute on the same connection as the
 * mutation-scope row lock.
 */
type DatabaseTransactionContext = {
  raw: postgres.TransactionSql;
  db: ReturnType<typeof drizzle> | TransactionHandle;
};

export const databaseTransactionStorage = new AsyncLocalStorage<DatabaseTransactionContext>();

/**
 * Database Singleton
 * Manages a single database connection throughout the application lifecycle
 */
class DatabaseSingleton {
  private static instance: DatabaseSingleton;
  private client: postgres.Sql | null = null;
  private db: ReturnType<typeof drizzle> | null = null;
  private isConnected = false;
  private connectPromise: Promise<void> | null = null;

  private constructor() {
    // Private constructor prevents direct instantiation
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): DatabaseSingleton {
    if (!DatabaseSingleton.instance) {
      DatabaseSingleton.instance = new DatabaseSingleton();
    }
    return DatabaseSingleton.instance;
  }

  /**
   * Initialize database connection (lazy initialization)
   */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      return; // Already connected
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const attempt = this.establishConnection();
    const sharedAttempt = attempt.finally(() => {
      if (this.connectPromise === sharedAttempt) this.connectPromise = null;
    });
    this.connectPromise = sharedAttempt;
    return sharedAttempt;
  }

  private async establishConnection(): Promise<void> {
    try {
      logInfo('Initializing database connection...');

      const config = getConfig();
      const connectionString = config.DATABASE_URL;
      const transactionPooler = isTransactionPoolerConnection(connectionString);

      this.client = postgres(connectionString, {
        max: config.DATABASE_POOL_MAX,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: !transactionPooler,
      });

      // Test the connection before exposing it. Production must use the
      // dedicated least-privilege writer LOGIN, never the migration or owner
      // role. CLI and test connections validate their own narrower contracts.
      await this.client`SELECT 1`;
      if (config.NODE_ENV === 'production') {
        await assertDataRuntimeRole(this.client);
      }

      this.db = drizzle(this.client, { schema });
      this.isConnected = true;

      logInfo('✅ Database connection established', {
        poolMax: config.DATABASE_POOL_MAX,
        preparedStatements: !transactionPooler,
      });
    } catch (error) {
      await this.client?.end().catch(() => undefined);
      this.client = null;
      this.db = null;
      this.isConnected = false;
      logError('❌ Failed to connect to database', error);
      throw error;
    }
  }

  /**
   * Get the database instance (auto-connects if needed)
   */
  public async getDb(): Promise<ReturnType<typeof drizzle>> {
    const transaction = databaseTransactionStorage.getStore();
    if (transaction) return transaction.db as ReturnType<typeof drizzle>;
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return this.db;
  }

  /**
   * Get the raw client (auto-connects if needed)
   */
  public async getClient(): Promise<postgres.Sql> {
    const transaction = databaseTransactionStorage.getStore();
    if (transaction) return transaction.raw as unknown as postgres.Sql;
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    return this.client;
  }

  /**
   * Check if database is connected
   */
  public isHealthy(): boolean {
    return this.isConnected && this.client !== null && this.db !== null;
  }

  /**
   * Test database connection
   */
  public async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected || !this.client) {
        return false;
      }

      await this.client`SELECT 1`;
      return true;
    } catch (error) {
      logError('Database health check failed', error);
      return false;
    }
  }

  /**
   * Close database connection
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      logInfo('Closing database connection...');
      await this.client.end();
      this.client = null;
      this.db = null;
      this.isConnected = false;
      logInfo('✅ Database connection closed');
    } catch (error) {
      logError('❌ Error closing database connection', error);
      throw error;
    }
  }

  /**
   * Force reconnection (useful for connection recovery)
   */
  public async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }
}

// Export singleton instance
export const databaseSingleton = DatabaseSingleton.getInstance();

// Convenience exports for repository and service callers.
export const getDb = () => databaseSingleton.getDb();
export const getDbClient = () => databaseSingleton.getClient();

export const runInDatabaseTransaction = <T>(
  transaction: postgres.TransactionSql,
  operation: () => Promise<T>,
  db: ReturnType<typeof drizzle> | TransactionHandle,
): Promise<T> => databaseTransactionStorage.run({ raw: transaction, db }, operation);

/**
 * Database handle, or an active transaction scoped to it. Repository factories
 * accept either so multi-write service flows can run atomically inside
 * `db.transaction((tx) => ...)` without type gymnastics.
 */
export type DbHandle = Awaited<ReturnType<typeof getDb>>;
export type TransactionHandle = Parameters<Parameters<DbHandle['transaction']>[0]>[0];
export type DbOrTransaction = DbHandle | TransactionHandle;

/**
 * Run an operation inside a PostgreSQL savepoint owned by the current
 * mutation transaction. Repositories resolve the nested Drizzle transaction
 * through AsyncLocalStorage, so a statement error can be rolled back without
 * poisoning the outer lifecycle transaction that records the failure state.
 */
export async function withDatabaseSavepoint<T>(operation: () => Promise<T>): Promise<T> {
  const context = databaseTransactionStorage.getStore();
  if (!context) {
    throw new Error('Database savepoint requires an active database transaction');
  }

  const transaction = context.db as TransactionHandle;
  return transaction.transaction(async (nestedTransaction) => {
    const raw = (
      nestedTransaction as unknown as {
        session?: { client?: postgres.TransactionSql };
      }
    ).session?.client;
    if (!raw) {
      throw new Error('Database savepoint did not expose its pinned postgres client');
    }
    return runInDatabaseTransaction(raw, operation, nestedTransaction);
  });
}

/**
 * Run raw postgres.js work in a transaction without assuming that the caller
 * owns the root client. Mutation scopes expose an already-pinned transaction
 * through AsyncLocalStorage; nesting `postgres.Sql.begin()` there is invalid
 * because `TransactionSql` has no `begin` method. Use a Drizzle savepoint for
 * that case and a normal postgres.js transaction for unscoped callers.
 */
export async function withDatabaseTransaction<T>(
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
  options: { isolationLevel?: 'repeatable read' } = {},
): Promise<T> {
  if (databaseTransactionStorage.getStore()) {
    // A savepoint inherits the outer transaction's isolation level. PostgreSQL
    // rejects SET TRANSACTION here, so callers that require repeatable reads
    // must establish it on the outer transaction before its first statement.
    return withDatabaseSavepoint(async () => {
      const nested = databaseTransactionStorage.getStore();
      if (!nested) {
        throw new Error('Database transaction context was lost inside its savepoint');
      }
      return operation(nested.raw);
    });
  }

  const client = await databaseSingleton.getClient();
  const beginOptions = options.isolationLevel
    ? `isolation level ${options.isolationLevel}`
    : undefined;
  return (await (beginOptions
    ? client.begin(beginOptions, operation)
    : client.begin(operation))) as T;
}
