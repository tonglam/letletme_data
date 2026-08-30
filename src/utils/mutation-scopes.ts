import { resolveMutationScopes } from '../domain/mutation-scope';
import {
  databaseTransactionStorage,
  getDb,
  runDatabasePostCommitActions,
  runInDatabaseTransaction,
} from '../db/singleton';
import { logInfo } from './logger';
import type postgres from 'postgres';

type MutationScopeInput = {
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

const MUTATION_SCOPE_WAIT_TIMEOUT_MS = 120_000;

export type MutationScopeSummary = Readonly<{
  scopeCount: number;
  scopeKinds: readonly string[];
}>;

/**
 * Return safe aggregate scope evidence for logs and operational responses.
 * Concrete scopes may contain entry, tournament, event, or other identifiers;
 * those values are intentionally never copied into the summary.
 */
export function summarizeMutationScopes(scopes: readonly string[]): MutationScopeSummary {
  const scopeKinds = [
    ...new Set(
      scopes.map((scope) => {
        const kind = scope.split(':', 1)[0]?.trim() ?? '';
        return /^[A-Za-z0-9._-]{1,64}$/.test(kind) ? kind : 'unknown';
      }),
    ),
  ].sort();
  return { scopeCount: scopes.length, scopeKinds };
}

/** Acquire all scopes in lexical order on the caller's PostgreSQL transaction.
 * Every canonical write using these scopes must run before the transaction
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
 * Hold deterministic PostgreSQL row locks for the complete canonical write.
 * `postgres.Sql.begin` pins one transaction even when DATABASE_URL points at a
 * transaction pooler; the scope therefore has no process-local ownership gap.
 */
async function withDatabaseMutationScopes<T>(
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const normalizedScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  if (normalizedScopes.length === 0) return operation();

  const db = await getDb();
  const parentContext = databaseTransactionStorage.getStore();
  const postCommitActions = parentContext?.postCommitActions ?? [];
  const actionStart = postCommitActions.length;
  // Use Drizzle's transaction API so the repository handle and raw postgres.js
  // client are pinned to the same connection. The raw client is an internal
  // property of PostgresJsTransaction, exposed here for raw SQL callers that
  // participate in the same scoped operation.
  try {
    const result = (await db.transaction(async (drizzleTransaction) => {
      const transaction = (
        drizzleTransaction as unknown as {
          session?: { client?: postgres.TransactionSql };
        }
      ).session?.client;
      if (!transaction) {
        throw new Error('Drizzle transaction did not expose its pinned postgres client');
      }
      // Supabase production sessions may inherit a much shorter
      // statement_timeout than the coordination lock window.  Without
      // overriding it here, a concurrent entry-info writer can abort the
      // advisory-scope acquisition after a few seconds even though the
      // mutation scope explicitly allows a 120s wait.  Keep both limits
      // aligned for scoped writes; the operation-level timeouts remain the
      // tighter guard for the actual canonical work.
      await transaction`SELECT set_config('statement_timeout', ${`${MUTATION_SCOPE_WAIT_TIMEOUT_MS}ms`}, true)`;
      await transaction`SELECT set_config('lock_timeout', ${`${MUTATION_SCOPE_WAIT_TIMEOUT_MS}ms`}, true)`;
      await acquireMutationScopes(transaction, normalizedScopes);
      return runInDatabaseTransaction(
        transaction,
        operation,
        drizzleTransaction,
        postCommitActions,
      );
    })) as T;
    if (!parentContext) await runDatabasePostCommitActions(postCommitActions);
    return result;
  } catch (error) {
    postCommitActions.splice(actionStart);
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

export async function withMutationScopes<T>(
  input: MutationScopeInput,
  operation: () => Promise<T>,
): Promise<T> {
  const scopes =
    input.scopes && input.scopes.length > 0 ? input.scopes : resolveMutationScopes(input);
  logInfo('Mutation database scopes requested', {
    queueName: input.queueName,
    jobName: input.jobName,
    jobId: input.jobId,
    ...summarizeMutationScopes(scopes),
  });
  return withDatabaseMutationScopes(scopes, operation);
}
