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
const PLAN_ONLY = process.argv.includes('--plan');
// These additive migrations were introduced by a branch merge after the
// production ledger had already recorded 0020. They are explicitly reviewed
// as safe lexical backfills; any future out-of-order migration must be added
// here deliberately instead of silently broadening the exception.
const APPROVED_BACKDATED_MIGRATIONS = new Map([
  [
    '0016_tournament_setup_reliability.sql',
    '8252c4b7c9f2170f34a0dd66dd09175a5df90105a9c9cc91f72c14985106316a',
  ],
  [
    '0017_core_mutation_safety.sql',
    '200160a6353becea9629880963715a0fa8556899354b0844a063ed4e9ed34d4f',
  ],
  [
    '0018_content_publication_freeze.sql',
    '08f30dc279b5a6eadf854f8ceb035bc6fe2156c4aed21c24a6f8f8a7c2458548',
  ],
  [
    '0019_bug_report_submission_request_hash.sql',
    '0382f100fea5bb283051d5d39c62c6b9a628c1191fa8fcbe9c44cbb58f79b947',
  ],
  [
    '0025_content_source_control_plane.sql',
    '5c021d17cf8df87ae29bdefd157954a1a31c0477e6b4c2cffaf17ea224ca61e7',
  ],
  [
    '0026_content_acquisition_run_engine.sql',
    'ed21128e967190b2726843ced57b6ec3753d8d57cc859ba0ee377d123b1bc92a',
  ],
]);
const STORAGE_MIGRATION = process.argv.includes('--storage-migration');
const STORAGE_MIGRATION_APPLY = process.argv.includes('--apply');

if (STORAGE_MIGRATION_APPLY && !STORAGE_MIGRATION) {
  throw new Error('--apply is only valid together with --storage-migration');
}
if (STATUS_ONLY && STORAGE_MIGRATION) {
  throw new Error('--status cannot be combined with --storage-migration');
}
if (PLAN_ONLY && (STATUS_ONLY || STORAGE_MIGRATION)) {
  throw new Error('--plan cannot be combined with --status or --storage-migration');
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
  contentControlPlaneObjects: string[];
  contentAcquisitionObjects: string[];
  contentSourceColumns: string[];
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
  const [state] = await sql<
    {
      has_ledger: boolean;
      platform_schemas: string[];
      content_control_plane_objects: string[];
      content_acquisition_objects: string[];
      content_source_columns: string[];
    }[]
  >`
    SELECT
      to_regclass('ops.schema_migrations') IS NOT NULL AS has_ledger,
      COALESCE((
        SELECT array_agg(namespace_row.nspname ORDER BY namespace_row.nspname)
        FROM pg_namespace namespace_row
        WHERE namespace_row.nspname = ANY (${PLATFORM_SCHEMAS as unknown as string[]})
      ), ARRAY[]::text[]) AS platform_schemas,
      COALESCE((
        SELECT array_agg(relname ORDER BY relname)
        FROM pg_class
        WHERE relnamespace = to_regnamespace('content')
          AND relkind IN ('r', 'p')
          AND relname = ANY (${
            [
              'source_endpoints',
              'source_partitions',
              'source_partition_members',
              'source_schedules',
              'source_registry_reconciliations',
            ] as unknown as string[]
          })
      ), ARRAY[]::text[]) AS content_control_plane_objects,
      COALESCE((
        SELECT array_agg(relname ORDER BY relname)
        FROM pg_class
        WHERE relnamespace = to_regnamespace('content')
          AND relkind IN ('r', 'p')
          AND relname = ANY (${
            [
              'acquisition_gaps',
              'acquisition_http_traces',
              'acquisition_provider_traces',
              'acquisition_job_outbox',
              'acquisition_budget_ledgers',
              'acquisition_budget_reservations',
            ] as unknown as string[]
          })
      ), ARRAY[]::text[]) AS content_acquisition_objects,
      COALESCE((
        SELECT array_agg(attname ORDER BY attname)
        FROM pg_attribute
        WHERE attrelid = to_regclass('content.sources')
          AND attnum > 0
          AND NOT attisdropped
          AND attname = ANY (${['source_key', 'origin', 'manifest_revision'] as unknown as string[]})
      ), ARRAY[]::text[]) AS content_source_columns
  `;
  if (!state) throw new Error('Failed to inspect database migration state');
  return {
    hasLedger: state.has_ledger,
    platformSchemas: state.platform_schemas,
    contentControlPlaneObjects: state.content_control_plane_objects,
    contentAcquisitionObjects: state.content_acquisition_objects,
    contentSourceColumns: state.content_source_columns,
  };
}

async function loadLedger(): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    SELECT filename, checksum
    FROM ops.schema_migrations
    ORDER BY filename
  `;
}

function ledgerFingerprint(ledger: readonly LedgerRow[]): string {
  return createHash('sha256')
    .update(ledger.map((row) => `${row.filename}:${row.checksum}`).join('\n'), 'utf8')
    .digest('hex');
}

const CONTENT_CONTROL_PLANE_OBJECTS = [
  'source_endpoints',
  'source_partitions',
  'source_partition_members',
  'source_schedules',
  'source_registry_reconciliations',
];
const CONTENT_ACQUISITION_OBJECTS = [
  'acquisition_gaps',
  'acquisition_http_traces',
  'acquisition_provider_traces',
  'acquisition_job_outbox',
  'acquisition_budget_ledgers',
  'acquisition_budget_reservations',
];

function assertContentMigrationState(ledger: readonly LedgerRow[], state: DatabaseState): void {
  const hasSourceControlPlane = ledger.some(
    (row) => row.filename === '0025_content_source_control_plane.sql',
  );
  const hasAcquisitionEngine = ledger.some(
    (row) => row.filename === '0026_content_acquisition_run_engine.sql',
  );
  const controlPartial =
    state.contentControlPlaneObjects.length > 0 || state.contentSourceColumns.length > 0;
  const acquisitionPartial = state.contentAcquisitionObjects.length > 0;
  if (!hasSourceControlPlane && controlPartial) {
    throw new Error('Content source-control objects exist without ledgered 0025 migration');
  }
  if (!hasAcquisitionEngine && acquisitionPartial) {
    throw new Error('Content acquisition objects exist without ledgered 0026 migration');
  }
  if (
    hasSourceControlPlane &&
    (state.contentControlPlaneObjects.length !== CONTENT_CONTROL_PLANE_OBJECTS.length ||
      state.contentSourceColumns.length !== 3)
  ) {
    throw new Error('Ledgered 0025 content migration is only partially applied');
  }
  if (
    hasAcquisitionEngine &&
    state.contentAcquisitionObjects.length !== CONTENT_ACQUISITION_OBJECTS.length
  ) {
    throw new Error('Ledgered 0026 content migration is only partially applied');
  }
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
          APPROVED_BACKDATED_MIGRATIONS.get(migration.filename) !== migration.checksum,
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

function assertApprovedBackfillChecksums(migrations: readonly Migration[]): void {
  for (const [filename, expectedChecksum] of APPROVED_BACKDATED_MIGRATIONS) {
    const migration = migrations.find((candidate) => candidate.filename === filename);
    if (!migration) throw new Error(`Approved backfill migration file is missing: ${filename}`);
    if (migration.checksum !== expectedChecksum) {
      throw new Error(
        `Approved backfill checksum mismatch for ${filename}; expected ${expectedChecksum}, got ${migration.checksum}`,
      );
    }
  }
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
  if (
    state.platformSchemas.length > 0 ||
    state.contentControlPlaneObjects.length > 0 ||
    state.contentAcquisitionObjects.length > 0 ||
    state.contentSourceColumns.length > 0
  ) {
    throw new Error(
      `Refusing to initialize a partial platform schema: ${[
        ...state.platformSchemas,
        ...state.contentControlPlaneObjects,
        ...state.contentAcquisitionObjects,
        ...state.contentSourceColumns,
      ].join(', ')}`,
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
    assertContentMigrationState(ledger, state);
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

async function printPlan(migrations: readonly Migration[], state: DatabaseState): Promise<void> {
  assertApprovedBackfillChecksums(migrations);
  if (!state.hasLedger) {
    console.log(
      JSON.stringify(
        {
          valid:
            state.platformSchemas.length === 0 &&
            state.contentControlPlaneObjects.length === 0 &&
            state.contentAcquisitionObjects.length === 0 &&
            state.contentSourceColumns.length === 0,
          hasLedger: false,
          platformSchemas: state.platformSchemas,
          pending: [INITIAL_MIGRATION],
          ledgerFingerprint: null,
          contentControlPlaneObjects: state.contentControlPlaneObjects,
          contentAcquisitionObjects: state.contentAcquisitionObjects,
          contentSourceColumns: state.contentSourceColumns,
        },
        null,
        2,
      ),
    );
    if (
      state.platformSchemas.length > 0 ||
      state.contentControlPlaneObjects.length > 0 ||
      state.contentAcquisitionObjects.length > 0 ||
      state.contentSourceColumns.length > 0
    )
      process.exitCode = 1;
    return;
  }

  const ledger = await loadLedger();
  assertContentMigrationState(ledger, state);
  if (ledger[0]?.filename !== INITIAL_MIGRATION) {
    throw new Error(`Migration ledger must start with ${INITIAL_MIGRATION}`);
  }
  const pending = pendingMigrations(migrations, ledger, false);
  console.log(
    JSON.stringify(
      {
        valid: true,
        hasLedger: true,
        appliedTail: ledger.at(-1)?.filename ?? null,
        ledgerFingerprint: ledgerFingerprint(ledger),
        pending: pending.map(({ filename, checksum }) => ({ filename, checksum })),
        contentControlPlaneObjects: state.contentControlPlaneObjects,
        contentAcquisitionObjects: state.contentAcquisitionObjects,
        contentSourceColumns: state.contentSourceColumns,
        approvedBackfills: [...APPROVED_BACKDATED_MIGRATIONS].map(([filename, checksum]) => ({
          filename,
          checksum,
        })),
      },
      null,
      2,
    ),
  );
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

    assertContentMigrationState(ledger, state);

    const pending = pendingMigrations(migrations, ledger, false);
    const beforeFingerprint = ledgerFingerprint(ledger);
    console.log(`[sql-migrate] ledger_before=${beforeFingerprint}`);
    for (const migration of pending) await applyMigration(migration);
    const afterLedger = await loadLedger();
    pendingMigrations(migrations, afterLedger, true);
    const afterFingerprint = ledgerFingerprint(afterLedger);
    console.log(
      `[sql-migrate] ledger_after=${afterFingerprint} changed=${String(beforeFingerprint !== afterFingerprint)}`,
    );
    console.log('[sql-migrate] up to date');
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.catch((error) => {
      console.error('[sql-migrate] failed to release advisory lock', error);
    });
  }
}

async function main(): Promise<void> {
  const migrations = loadMigrations();
  assertApprovedBackfillChecksums(migrations);
  const state = await inspectDatabaseState();
  if (STATUS_ONLY) {
    await printStatus(migrations, state);
    return;
  }
  if (PLAN_ONLY) {
    await printPlan(migrations, state);
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
