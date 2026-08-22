/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../src/db/schemas/index.schema';
import { isTransactionPoolerConnection } from '../src/db/postgres-connection';
import { createBugReportRepository } from '../src/repositories/bug-reports';
import { runBugReportStorageMigration } from '../src/services/bug-report-storage-migration.service';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? 'migrations';
const INITIAL_MIGRATION = '0000_platform_baseline.sql';
const PLATFORM_SCHEMAS = ['bridge', 'competition', 'fpl', 'ops', 'reporting', 'understat'];
const ADVISORY_LOCK_KEY = 912_883_471;
const STATUS_ONLY = process.argv.includes('--status');
// These additive migrations were introduced by a branch merge after the
// production ledger had already recorded 0020. They are explicitly reviewed
// as safe lexical backfills; any future out-of-order migration must be added
// here deliberately instead of silently broadening the exception.
const APPROVED_BACKDATED_MIGRATIONS = new Set([
  '0016_tournament_setup_reliability.sql',
  '0017_core_mutation_safety.sql',
  '0018_content_publication_freeze.sql',
  '0019_bug_report_submission_request_hash.sql',
  '0025_content_source_control_plane.sql',
  '0026_content_acquisition_run_engine.sql',
]);
const STORAGE_MIGRATION = process.argv.includes('--storage-migration');
const STORAGE_MIGRATION_APPLY = process.argv.includes('--apply');

if (STORAGE_MIGRATION_APPLY && !STORAGE_MIGRATION) {
  throw new Error('--apply is only valid together with --storage-migration');
}
if (STATUS_ONLY && STORAGE_MIGRATION) {
  throw new Error('--status cannot be combined with --storage-migration');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

if (isTransactionPoolerConnection(databaseUrl)) {
  throw new Error(
    'The migration runner requires direct PostgreSQL or a session-mode pooler connection; transaction poolers cannot hold its advisory lock',
  );
}

const sql = postgres(databaseUrl, { max: 1, prepare: true });

type Migration = {
  filename: string;
  checksum: string;
  contents: string;
};

type LedgerRow = {
  filename: string;
  checksum: string;
};

type DatabaseState = {
  hasLedger: boolean;
  platformSchemas: string[];
};

const checksum = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

function loadMigrations(): Migration[] {
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/.test(filename))
    .sort()
    .map((filename) => {
      const contents = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, contents, checksum: checksum(contents) };
    });

  if (migrations[0]?.filename !== INITIAL_MIGRATION) {
    throw new Error(`Migration history must start with ${INITIAL_MIGRATION}`);
  }
  return migrations;
}

async function inspectDatabaseState(): Promise<DatabaseState> {
  const [state] = await sql<{ has_ledger: boolean; platform_schemas: string[] }[]>`
    SELECT
      to_regclass('ops.schema_migrations') IS NOT NULL AS has_ledger,
      COALESCE((
        SELECT array_agg(namespace_row.nspname ORDER BY namespace_row.nspname)
        FROM pg_namespace namespace_row
        WHERE namespace_row.nspname = ANY (${PLATFORM_SCHEMAS as unknown as string[]})
      ), ARRAY[]::text[]) AS platform_schemas
  `;
  if (!state) throw new Error('Failed to inspect database migration state');
  return { hasLedger: state.has_ledger, platformSchemas: state.platform_schemas };
}

async function loadLedger(): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    SELECT filename, checksum
    FROM ops.schema_migrations
    ORDER BY filename
  `;
}

function pendingMigrations(
  migrations: readonly Migration[],
  ledger: readonly LedgerRow[],
  requireComplete: boolean,
): Migration[] {
  const localByName = new Map(migrations.map((migration) => [migration.filename, migration]));
  const applied = new Set<string>();

  for (const row of ledger) {
    if (applied.has(row.filename))
      throw new Error(`Duplicate migration ledger row: ${row.filename}`);
    applied.add(row.filename);
    const migration = localByName.get(row.filename);
    if (!migration) throw new Error(`Ledgered migration file is missing: ${row.filename}`);
    if (migration.checksum !== row.checksum) {
      throw new Error(`Checksum mismatch for applied migration ${row.filename}`);
    }
  }

  const latestApplied = ledger.at(-1)?.filename;
  const pending = migrations.filter((migration) => !applied.has(migration.filename));
  const disallowedBackdated = latestApplied
    ? pending.filter(
        (migration) =>
          migration.filename < latestApplied &&
          !APPROVED_BACKDATED_MIGRATIONS.has(migration.filename),
      )
    : [];
  if (disallowedBackdated.length > 0) {
    throw new Error(
      `Pending migrations sort before applied tail ${latestApplied}: ${disallowedBackdated
        .map((migration) => migration.filename)
        .join(', ')}; review and allowlist additive backfills explicitly`,
    );
  }
  if (requireComplete && pending.length > 0) {
    throw new Error(
      `Pending migrations: ${pending.map((migration) => migration.filename).join(', ')}`,
    );
  }
  return pending;
}

async function applyMigration(migration: Migration): Promise<void> {
  const startedAt = performance.now();
  await sql.begin(async (transaction) => {
    await transaction`SELECT set_config('lock_timeout', '5s', true)`;
    await transaction`SELECT set_config('statement_timeout', '15min', true)`;
    await transaction.unsafe(migration.contents);
    await transaction`
      INSERT INTO ops.schema_migrations (filename, checksum)
      VALUES (${migration.filename}, ${migration.checksum})
    `;
  });
  console.log(
    `[sql-migrate] applied ${migration.filename} duration_ms=${(
      performance.now() - startedAt
    ).toFixed(2)}`,
  );
}

async function applyInitialMigration(migration: Migration): Promise<void> {
  const state = await inspectDatabaseState();
  if (state.platformSchemas.length > 0) {
    throw new Error(
      `Refusing to initialize a partial platform schema: ${state.platformSchemas.join(', ')}`,
    );
  }
  await applyMigration(migration);
}

async function printStatus(migrations: readonly Migration[], state: DatabaseState): Promise<void> {
  if (!state.hasLedger) {
    console.log(`pending ${INITIAL_MIGRATION}`);
    if (state.platformSchemas.length > 0) {
      console.log(`invalid partial platform schemas: ${state.platformSchemas.join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const ledger = await loadLedger();
    if (ledger[0]?.filename !== INITIAL_MIGRATION) {
      throw new Error(`Migration ledger must start with ${INITIAL_MIGRATION}`);
    }
    pendingMigrations(migrations, ledger, true);
    for (const migration of migrations) console.log(`applied ${migration.filename}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

async function migrate(migrations: readonly Migration[]): Promise<void> {
  const initial = migrations[0];
  if (!initial) throw new Error('No initial migration found');

  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    const state = await inspectDatabaseState();
    let ledger: LedgerRow[];
    if (!state.hasLedger) {
      await applyInitialMigration(initial);
      ledger = await loadLedger();
    } else {
      ledger = await loadLedger();
      if (ledger[0]?.filename !== INITIAL_MIGRATION) {
        throw new Error(
          `Migration ledger is not using ${INITIAL_MIGRATION}; manual cleanup is required`,
        );
      }
    }

    const pending = pendingMigrations(migrations, ledger, false);
    for (const migration of pending) await applyMigration(migration);
    pendingMigrations(migrations, await loadLedger(), true);
    console.log('[sql-migrate] up to date');
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.catch((error) => {
      console.error('[sql-migrate] failed to release advisory lock', error);
    });
  }
}

async function main(): Promise<void> {
  const migrations = loadMigrations();
  const state = await inspectDatabaseState();
  if (STATUS_ONLY) {
    await printStatus(migrations, state);
    return;
  }
  await migrate(migrations);

  if (STORAGE_MIGRATION) {
    const migrationDb = drizzle(sql, { schema });
    const result = await runBugReportStorageMigration({
      dryRun: !STORAGE_MIGRATION_APPLY,
      repository: createBugReportRepository(migrationDb),
    });
    console.log(`[storage-migrate] ${JSON.stringify(result)}`);
    if (STORAGE_MIGRATION_APPLY && result.failed > 0) {
      throw new Error(
        `Storage migration completed with ${result.failed} failed item(s); rerun after remediation`,
      );
    }
  }
}

main()
  .catch((error) => {
    console.error('[sql-migrate] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
