import type postgres from 'postgres';

import { getDb, type DbHandle } from '../db/singleton';
import { withPostgresQueryTimeout } from '../db/postgres-query-timeout';
import {
  LIVE_SNAPSHOT_DB_CHECKPOINT_WRITE_BUDGET_MS,
  LIVE_SNAPSHOT_DB_READ_BUDGET_MS,
} from '../domain/data-contracts';
import { withTimeout } from './async';

export type LiveSnapshotDatabaseBudget = Readonly<{
  /** Short control-row budget for lane/season authority transitions. */
  controlDb: DbHandle;
  readDb: DbHandle;
  writeDb: DbHandle;
  /** Raw SQL handles for the few live read repositories that use tagged SQL. */
  readClient: postgres.Sql;
  deadlineAt: number;
  readBudgetMs: number;
  writeBudgetMs: number;
}>;

type SessionWithClient = {
  client: postgres.Sql | postgres.TransactionSql;
};

// A bounded proxy is cached per underlying postgres client and budget. This
// prevents every 30-second live poll from creating another independent queue
// of connection-acquisition waiters while preserving the configured pool size.
const boundedClientCache = new WeakMap<
  object,
  Map<number, postgres.Sql | postgres.TransactionSql>
>();

function getBoundedClient(
  db: DbHandle,
  timeoutMs: number,
  deadlineAt: number,
): postgres.Sql | postgres.TransactionSql {
  const session = (db as unknown as { session?: SessionWithClient }).session;
  if (!session?.client) throw new Error('Live snapshot database session is unavailable');
  let clients = boundedClientCache.get(session.client as object);
  if (!clients) {
    clients = new Map();
    boundedClientCache.set(session.client as object, clients);
  }
  let client = clients.get(timeoutMs);
  if (!client) {
    const root = session.client;
    const rootOptions = (root as postgres.Sql & { options?: { max?: number } }).options;
    const capacity =
      typeof rootOptions?.max === 'number' && Number.isSafeInteger(rootOptions.max)
        ? Math.max(1, rootOptions.max)
        : 1;
    client = withPostgresQueryTimeout(root, timeoutMs, undefined, capacity);
    clients.set(timeoutMs, client);
  }
  return withPostgresQueryTimeout(client, timeoutMs, deadlineAt);
}

/** Return a bounded raw client for legacy tagged-SQL live read paths. */
export function boundedClient(db: DbHandle, timeoutMs: number, deadlineAt: number): postgres.Sql {
  return getBoundedClient(db, timeoutMs, deadlineAt) as postgres.Sql;
}

export function boundedDb(db: DbHandle, timeoutMs: number, deadlineAt: number): DbHandle {
  const session = (db as unknown as { session?: SessionWithClient }).session;
  if (!session?.client) throw new Error('Live snapshot database session is unavailable');
  const boundedSession = Object.create(session) as SessionWithClient;
  boundedSession.client = getBoundedClient(db, timeoutMs, deadlineAt);
  const bounded = Object.create(db) as DbHandle & { session: SessionWithClient };
  bounded.session = boundedSession;
  return bounded;
}

/**
 * Build local Drizzle handles for one live snapshot execution. SQL statements
 * are cancelled and awaited by withPostgresQueryTimeout; the caller's
 * execution deadline is shared by both the five-second reads and the
 * thirty-second checkpoint transaction.
 */
export async function createLiveSnapshotDatabaseBudget(
  executionBudgetMs: number | null = 90_000,
): Promise<LiveSnapshotDatabaseBudget> {
  // FINAL reconciliation has its own business SLA and must not inherit the
  // ordinary 90-second live polling deadline. A null deadline still applies
  // the per-operation read/write budgets through the wrapped clients.
  const deadlineAt =
    executionBudgetMs === null
      ? Number.POSITIVE_INFINITY
      : Date.now() + Math.max(1, Math.floor(executionBudgetMs));
  const db = await withTimeout(
    getDb(),
    LIVE_SNAPSHOT_DB_READ_BUDGET_MS,
    'Live snapshot database connection acquisition exceeded its read budget',
  );
  const readClient = boundedClient(db, LIVE_SNAPSHOT_DB_READ_BUDGET_MS, deadlineAt);
  return {
    controlDb: boundedDb(db, LIVE_SNAPSHOT_DB_READ_BUDGET_MS, deadlineAt),
    readDb: boundedDb(db, LIVE_SNAPSHOT_DB_READ_BUDGET_MS, deadlineAt),
    writeDb: boundedDb(db, LIVE_SNAPSHOT_DB_CHECKPOINT_WRITE_BUDGET_MS, deadlineAt),
    readClient,
    deadlineAt,
    readBudgetMs: LIVE_SNAPSHOT_DB_READ_BUDGET_MS,
    writeBudgetMs: LIVE_SNAPSHOT_DB_CHECKPOINT_WRITE_BUDGET_MS,
  };
}

/** One bounded handle for telemetry writers that are outside the live worker. */
export async function getDatabaseHandleWithBudget(timeoutMs: number): Promise<DbHandle> {
  const budget = Math.max(1, Math.floor(timeoutMs));
  const deadlineAt = Date.now() + budget;
  const db = await withTimeout(
    getDb(),
    budget,
    'Database handle acquisition exceeded its local budget',
  );
  return boundedDb(db, budget, deadlineAt);
}
