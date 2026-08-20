import { resolveMutationScopes } from '../domain/mutation-scope';
import { getDb, runInDatabaseTransaction } from '../db/singleton';
import { logInfo } from './logger';
import type postgres from 'postgres';

type MutationLockInput = {
  queueName: string;
  jobName: string;
  jobId?: string;
  eventId?: number;
  tournamentId?: number;
  /**
   * Optional explicit scopes. When set, bypasses `resolveMutationScopes` so
   * long multi-phase jobs (e.g. tournament setup) can lock only the phases
   * that write shared structure tables (FP-07 Codex P1).
   */
  scopes?: string[];
};

const WAIT_TIMEOUT_MS = 120_000;

/** Acquire all scopes in lexical order on the caller's PostgreSQL transaction.
 * Every canonical write guarded by this helper must run before the transaction
 * callback returns, so commit/rollback/process death releases the locks. */
export async function acquireMutationScopes(
  transaction: postgres.TransactionSql,
  scopes: readonly string[],
): Promise<void> {
  const normalizedScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  for (const scope of normalizedScopes) {
    await transaction`
      INSERT INTO ops.mutation_scopes (scope_key, last_used_at)
      VALUES (${scope}, clock_timestamp())
      ON CONFLICT (scope_key)
      DO UPDATE SET last_used_at = EXCLUDED.last_used_at
    `;
    await transaction`
      SELECT scope_key
      FROM ops.mutation_scopes
      WHERE scope_key = ${scope}
      FOR UPDATE
    `;
  }
}

/**
 * The old implementation held Redis leases while arbitrary DB work ran.  A
 * missed heartbeat could silently expire the lease while the operation kept
 * mutating canonical data.  Keep the existing call-site contract, but hold
 * deterministic PostgreSQL row locks for the complete guarded operation.
 * `postgres.Sql.begin` pins one transaction even when DATABASE_URL points at a
 * transaction pooler; the lock therefore has no process-local ownership gap.
 */
async function withDatabaseMutationScopes<T>(
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const normalizedScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  if (normalizedScopes.length === 0) return operation();

  const db = await getDb();
  // Use Drizzle's transaction API so the repository handle and raw postgres.js
  // client are pinned to the same connection. The raw client is an internal
  // property of PostgresJsTransaction, exposed here only for legacy raw SQL
  // callers that already participate in the guarded operation.
  try {
    return (await db.transaction(async (drizzleTransaction) => {
      const transaction = (
        drizzleTransaction as unknown as {
          session?: { client?: postgres.TransactionSql };
        }
      ).session?.client;
      if (!transaction) {
        throw new Error('Drizzle transaction did not expose its pinned postgres client');
      }
      await transaction`SELECT set_config('lock_timeout', ${`${WAIT_TIMEOUT_MS}ms`}, true)`;
      await acquireMutationScopes(transaction, normalizedScopes);
      return runInDatabaseTransaction(transaction, operation, drizzleTransaction);
    })) as T;
  } catch (error) {
    // Some legacy unit suites point at a disposable pre-0015 database.  Keep
    // those isolated tests useful without ever weakening a production guard:
    // a missing coordination table is fail-closed outside NODE_ENV=test.
    if (
      process.env.NODE_ENV === 'test' &&
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === '42P01'
    ) {
      return operation();
    }
    throw error;
  }
}

/** Kept as a compatibility name while callers migrate to DB coordination. */
export async function closeLockClient(): Promise<void> {
  // No Redis lock client remains.  Database connections are owned by the
  // singleton and are closed by the normal worker shutdown path.
}

/**
 * Compatibility assertion for repositories that also participate in guarded
 * mutations. PostgreSQL row locks are held by the transaction opened by
 * `withMutationConflictGuard`, so there is no independent expiring lease to
 * re-check here.
 */
export function assertMutationLockHealthy(): void {
  // The transaction-scoped mutation lock is the health fence.
}

export async function withMutationConflictGuard<T>(
  input: MutationLockInput,
  operation: () => Promise<T>,
): Promise<T> {
  const scopes =
    input.scopes && input.scopes.length > 0 ? input.scopes : resolveMutationScopes(input);
  logInfo('Mutation database scopes requested', {
    queueName: input.queueName,
    jobName: input.jobName,
    jobId: input.jobId,
    scopes,
  });
  return withDatabaseMutationScopes(scopes, operation);
}
