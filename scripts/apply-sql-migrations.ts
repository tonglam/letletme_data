/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';

import { isTransactionPoolerConnection } from '../src/db/postgres-connection';

import {
  adoptProductionPlatformBaseline,
  assertCanonicalCapabilityRoleContract,
  assertCanonicalCapabilityRoleMemberships,
  EXPECTED_BASELINE_PLATFORM_SCHEMA_FINGERPRINT,
  EXPECTED_CURRENT_PLATFORM_SCHEMA_FINGERPRINT,
} from './platform-baseline-adoption';
import {
  fingerprintSchemaContract,
  loadPlatformSchemaContract,
  loadReportingMaterializedViewState,
  PLATFORM_SCHEMAS,
} from './platform-schema-contract';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? 'migrations';
const BASELINE_FILENAME = '0000_platform_baseline.sql';
const ADVISORY_LOCK_KEY = 912_883_471;
const STATUS_ONLY = process.argv.includes('--status');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

if (isTransactionPoolerConnection(databaseUrl)) {
  throw new Error(
    'The migration runner requires a direct PostgreSQL connection; transaction poolers cannot hold its advisory lock',
  );
}

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: true,
});

type Migration = {
  filename: string;
  checksum: string;
  contents: string;
};

type LedgerRow = {
  filename: string;
  checksum: string;
  applied_at: Date;
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

  if (migrations[0]?.filename !== BASELINE_FILENAME) {
    throw new Error(`Migration history must start with ${BASELINE_FILENAME}`);
  }
  const duplicateNames = migrations.filter(
    (migration, index) =>
      migrations.findIndex((item) => item.filename === migration.filename) !== index,
  );
  if (duplicateNames.length > 0) throw new Error('Migration filenames must be unique');
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

async function hasRuntimeData(sqlClient: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const [{ exists }] = await sqlClient<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM fpl.seasons) AS exists
  `;
  return exists;
}

async function loadLedger(): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    SELECT filename, checksum, applied_at
    FROM ops.schema_migrations
    ORDER BY filename
  `;
}

async function assertFreshBaselineContract(transaction: postgres.TransactionSql): Promise<void> {
  const schemaFingerprint = fingerprintSchemaContract(
    await loadPlatformSchemaContract(transaction),
  );
  if (schemaFingerprint !== EXPECTED_BASELINE_PLATFORM_SCHEMA_FINGERPRINT) {
    throw new Error(
      `Fresh baseline schema fingerprint mismatch: expected=${EXPECTED_BASELINE_PLATFORM_SCHEMA_FINGERPRINT} actual=${schemaFingerprint}`,
    );
  }

  const materializedViews = await loadReportingMaterializedViewState(transaction);
  const expectedNames = ['tournament_entry_event_summaries', 'tournament_selection_stats'];
  if (
    materializedViews.length !== expectedNames.length ||
    materializedViews.some((view, index) => view.name !== expectedNames[index] || view.isPopulated)
  ) {
    throw new Error('Fresh baseline materialized views must exist WITH NO DATA');
  }
}

async function assertCanonicalSchemaContract(): Promise<void> {
  const schemaFingerprint = fingerprintSchemaContract(await loadPlatformSchemaContract(sql));
  if (schemaFingerprint !== EXPECTED_CURRENT_PLATFORM_SCHEMA_FINGERPRINT) {
    throw new Error(
      `Current platform schema fingerprint mismatch: expected=${EXPECTED_CURRENT_PLATFORM_SCHEMA_FINGERPRINT} actual=${schemaFingerprint}`,
    );
  }
}

async function assertCanonicalReportingState(): Promise<void> {
  const materializedViews = await loadReportingMaterializedViewState(sql);
  const expectedNames = ['tournament_entry_event_summaries', 'tournament_selection_stats'];
  if (
    materializedViews.length !== expectedNames.length ||
    materializedViews.some((view, index) => view.name !== expectedNames[index] || !view.isPopulated)
  ) {
    throw new Error('Canonical reporting materialized views are not fully populated');
  }
}

async function applyFreshBaseline(baseline: Migration): Promise<void> {
  const startedAt = performance.now();
  await sql.begin(async (transaction) => {
    await transaction`SELECT set_config('lock_timeout', '5s', true)`;
    await transaction`SELECT set_config('statement_timeout', '15min', true)`;
    await transaction.unsafe(baseline.contents);
    await assertFreshBaselineContract(transaction);
    await transaction`
      INSERT INTO ops.schema_migrations (filename, checksum)
      VALUES (${baseline.filename}, ${baseline.checksum})
    `;
  });
  console.log(
    `[sql-migrate] applied ${baseline.filename} duration_ms=${(
      performance.now() - startedAt
    ).toFixed(2)}`,
  );
}

async function adoptProductionBaseline(baseline: Migration): Promise<void> {
  const startedAt = performance.now();
  await sql.begin(async (transaction) => {
    await transaction`SELECT set_config('lock_timeout', '5s', true)`;
    await transaction`SELECT set_config('statement_timeout', '30min', true)`;
    await adoptProductionPlatformBaseline(transaction, baseline.filename, baseline.checksum);
  });
  console.log(
    `[sql-migrate] adopted ${baseline.filename} duration_ms=${(
      performance.now() - startedAt
    ).toFixed(2)}`,
  );
}

function assertCanonicalLedger(
  migrations: readonly Migration[],
  ledger: readonly LedgerRow[],
  requireComplete: boolean,
): Migration[] {
  const localByName = new Map(migrations.map((migration) => [migration.filename, migration]));
  const appliedByName = new Map<string, LedgerRow>();
  for (const row of ledger) {
    if (appliedByName.has(row.filename)) {
      throw new Error(`Duplicate migration ledger row: ${row.filename}`);
    }
    appliedByName.set(row.filename, row);
    const migration = localByName.get(row.filename);
    if (!migration) throw new Error(`Ledgered migration file is missing: ${row.filename}`);
    if (row.checksum !== migration.checksum) {
      throw new Error(`Checksum mismatch for applied migration ${row.filename}`);
    }
  }

  const latestApplied = ledger.at(-1)?.filename;
  const pending = migrations.filter((migration) => !appliedByName.has(migration.filename));
  const backdated = latestApplied
    ? pending.filter((migration) => migration.filename < latestApplied)
    : [];
  if (backdated.length > 0) {
    throw new Error(
      `Pending migrations sort before applied tail ${latestApplied}: ${backdated
        .map((migration) => migration.filename)
        .join(', ')}`,
    );
  }
  if (requireComplete && pending.length > 0) {
    throw new Error(
      `Pending migrations: ${pending.map((migration) => migration.filename).join(', ')}`,
    );
  }
  return pending;
}

async function applyPendingMigration(migration: Migration): Promise<void> {
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

async function printStatus(migrations: readonly Migration[], state: DatabaseState): Promise<void> {
  if (!state.hasLedger) {
    console.log(`pending  ${BASELINE_FILENAME}`);
    if (state.platformSchemas.length > 0) {
      console.log(`invalid  partial platform schemas: ${state.platformSchemas.join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  const ledger = await loadLedger();
  if (ledger[0]?.filename !== BASELINE_FILENAME) {
    console.log(`pending  ${BASELINE_FILENAME} (strict production adoption required)`);
    process.exitCode = 1;
    return;
  }

  try {
    assertCanonicalLedger(migrations, ledger, true);
    await assertCanonicalCapabilityRoleMemberships(sql, true);
    const runtimeData = await hasRuntimeData(sql);
    if (runtimeData) {
      await assertCanonicalCapabilityRoleContract(sql);
      await assertCanonicalReportingState();
    }
    await assertCanonicalSchemaContract();
    for (const migration of migrations) console.log(`applied  ${migration.filename}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

async function migrate(migrations: readonly Migration[]): Promise<void> {
  const baseline = migrations[0];
  if (!baseline) throw new Error('No baseline migration found');

  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    let state = await inspectDatabaseState();
    const startedFromEmptyDatabase = !state.hasLedger;
    let ledger: LedgerRow[];
    if (!state.hasLedger) {
      if (state.platformSchemas.length > 0) {
        throw new Error(
          `Refusing to baseline a partial platform schema: ${state.platformSchemas.join(', ')}`,
        );
      }
      await applyFreshBaseline(baseline);
      ledger = await loadLedger();
    } else {
      ledger = await loadLedger();
      if (ledger[0]?.filename !== BASELINE_FILENAME) {
        await adoptProductionBaseline(baseline);
        state = await inspectDatabaseState();
        if (!state.hasLedger) throw new Error('Baseline adoption removed the migration ledger');
        ledger = await loadLedger();
      }
    }

    const pending = assertCanonicalLedger(migrations, ledger, false);
    const runtimeData = await hasRuntimeData(sql);
    const requireCompleteMemberships =
      !startedFromEmptyDatabase && (runtimeData || pending.length > 0);
    await assertCanonicalCapabilityRoleMemberships(sql, requireCompleteMemberships);
    if (requireCompleteMemberships) {
      await assertCanonicalCapabilityRoleContract(sql);
      await assertCanonicalReportingState();
    }
    for (const migration of pending) await applyPendingMigration(migration);
    await assertCanonicalSchemaContract();
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
}

main()
  .catch((error) => {
    console.error('[sql-migrate] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
