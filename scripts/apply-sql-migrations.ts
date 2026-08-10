/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';

import { isTransactionPoolerConnection } from '../src/db/postgres-connection';

import {
  inspectMigrationHistory,
  selectMigrationFilesForLedger,
  selectMigrationFilesThrough,
  selectSqlMigrationLedger,
  type SqlMigrationLedger,
} from './migration-history';
import {
  getSqlMigrationLocalTimeouts,
  getSqlMigrationExecutionContents,
  getSqlMigrationPreconditions,
} from './sql-migration-compatibility';

const migrationsDir = process.env.MIGRATIONS_DIR ?? 'migrations';
const databaseUrl = process.env.DATABASE_URL;
const statusOnly = process.argv.includes('--status');
const throughArgumentIndex = process.argv.indexOf('--through');
const throughMigration =
  throughArgumentIndex === -1 ? undefined : process.argv[throughArgumentIndex + 1];

if (throughArgumentIndex !== -1 && !throughMigration) {
  console.error('--through requires an exact migration filename');
  process.exit(1);
}

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: !isTransactionPoolerConnection(databaseUrl),
});
const advisoryLockKey = 912_883_471;

type LedgerRow = { filename: string; checksum: string | null; applied_at: Date };
type LedgerProbe = { public_relation_kind: string | null; has_ops_ledger: boolean };

const checksum = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

async function probeLedger(): Promise<SqlMigrationLedger> {
  const [probe] = await sql<LedgerProbe[]>`
    SELECT
      (
        SELECT relation_row.relkind::text
        FROM pg_class relation_row
        JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND relation_row.relname = 'sql_migrations'
      ) AS public_relation_kind,
      to_regclass('ops.schema_migrations') IS NOT NULL AS has_ops_ledger
  `;

  return selectSqlMigrationLedger(probe.public_relation_kind, probe.has_ops_ledger);
}

async function ensureLedger(): Promise<SqlMigrationLedger> {
  const ledger = await probeLedger();
  if (ledger === 'ops') return ledger;

  await sql`
    CREATE TABLE IF NOT EXISTS public.sql_migrations (
      filename text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE public.sql_migrations ADD COLUMN IF NOT EXISTS checksum text`;
  return ledger;
}

function listJournaledMigrationFiles(): Set<string> {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  try {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries?: { tag?: string }[];
    };
    return new Set(
      (journal.entries ?? [])
        .map((entry) => entry.tag)
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => `${tag}.sql`),
    );
  } catch {
    console.warn(
      `[sql-migrate] no readable journal at ${journalPath}; treating all files as pending`,
    );
    return new Set();
  }
}

function listSqlMigrationFiles(): string[] {
  const journaled = listJournaledMigrationFiles();
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name) => !journaled.has(name))
    .sort();
}

function readMigration(filename: string): { contents: string; checksum: string } {
  const contents = readFileSync(join(migrationsDir, filename), 'utf8');
  return { contents, checksum: checksum(contents) };
}

async function loadLedger(ledger: SqlMigrationLedger): Promise<Map<string, LedgerRow>> {
  const rows =
    ledger === 'ops'
      ? await sql<LedgerRow[]>`
          SELECT filename, checksum, applied_at
          FROM ops.schema_migrations
          ORDER BY filename
        `
      : await sql<LedgerRow[]>`
          SELECT filename, checksum, applied_at
          FROM public.sql_migrations
          ORDER BY filename
        `;
  return new Map(rows.map((row) => [row.filename, row]));
}

async function adoptOrVerifyApplied(
  filename: string,
  expectedChecksum: string,
  row: LedgerRow,
  ledger: SqlMigrationLedger,
): Promise<void> {
  if (row.checksum === null) {
    if (ledger === 'ops') {
      await sql`
        UPDATE ops.schema_migrations
        SET checksum = ${expectedChecksum}
        WHERE filename = ${filename} AND checksum IS NULL
      `;
    } else {
      await sql`
        UPDATE public.sql_migrations
        SET checksum = ${expectedChecksum}
        WHERE filename = ${filename} AND checksum IS NULL
      `;
    }
    console.log(`[sql-migrate] adopted checksum ${filename}`);
    return;
  }
  if (row.checksum !== expectedChecksum) {
    throw new Error(
      `checksum mismatch for applied migration ${filename}: ledger=${row.checksum} file=${expectedChecksum}`,
    );
  }
}

async function applyFile(filename: string, contents: string, digest: string): Promise<void> {
  const startedAt = performance.now();
  await sql.begin(async (tx) => {
    const localTimeouts = getSqlMigrationLocalTimeouts(contents);
    if (localTimeouts.lockTimeout) {
      await tx`SELECT set_config('lock_timeout', ${localTimeouts.lockTimeout}, true)`;
    }
    if (localTimeouts.statementTimeout) {
      await tx`SELECT set_config('statement_timeout', ${localTimeouts.statementTimeout}, true)`;
    }

    for (const statement of getSqlMigrationPreconditions(filename)) {
      await tx.unsafe(statement);
    }
    await tx.unsafe(getSqlMigrationExecutionContents(filename, contents));

    // Re-probe after the migration: 0090 atomically changes ledger authority.
    const [probe] = await tx<LedgerProbe[]>`
      SELECT
        (
          SELECT relation_row.relkind::text
          FROM pg_class relation_row
          JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
          WHERE namespace_row.nspname = 'public'
            AND relation_row.relname = 'sql_migrations'
        ) AS public_relation_kind,
        to_regclass('ops.schema_migrations') IS NOT NULL AS has_ops_ledger
    `;
    const ledger = selectSqlMigrationLedger(probe.public_relation_kind, probe.has_ops_ledger);

    if (ledger === 'ops') {
      await tx`
        INSERT INTO ops.schema_migrations (filename, checksum)
        VALUES (${filename}, ${digest})
      `;
    } else {
      await tx`
        INSERT INTO public.sql_migrations (filename, checksum)
        VALUES (${filename}, ${digest})
      `;
    }
  });
  const durationMs = performance.now() - startedAt;
  console.log(`[sql-migrate] applied ${filename} duration_ms=${durationMs.toFixed(2)}`);
}

async function printStatus(files: string[], ledger: Map<string, LedgerRow>): Promise<void> {
  let invalid = false;
  const { missing, backdated, latestApplied } = inspectMigrationHistory(files, ledger.keys());
  const backdatedSet = new Set(backdated);

  for (const filename of files) {
    const migration = readMigration(filename);
    const row = ledger.get(filename);
    if (backdatedSet.has(filename)) {
      console.log(`backdated ${filename} (latest applied: ${latestApplied})`);
      invalid = true;
    } else if (!row) {
      console.log(`pending  ${filename}`);
      invalid = true;
    } else if (row.checksum === null) {
      console.log(`legacy   ${filename} (checksum not adopted)`);
      invalid = true;
    } else if (row.checksum !== migration.checksum) {
      console.log(`mismatch ${filename}`);
      invalid = true;
    } else {
      console.log(`applied  ${filename}`);
    }
  }

  for (const filename of missing) {
    console.log(`missing  ${filename} (ledgered file absent)`);
    invalid = true;
  }

  if (invalid) process.exitCode = 1;
}

async function applyMigrations(
  files: string[],
  initialLedger: SqlMigrationLedger,
  ledger: Map<string, LedgerRow>,
): Promise<void> {
  await sql`SELECT pg_advisory_lock(${advisoryLockKey})`;
  try {
    const { missing, backdated, latestApplied } = inspectMigrationHistory(files, ledger.keys());
    if (missing.length > 0) {
      throw new Error(`ledgered migration files are missing: ${missing.join(', ')}`);
    }
    if (backdated.length > 0) {
      throw new Error(
        `pending migrations sort before the applied tail ${latestApplied}: ${backdated.join(', ')}`,
      );
    }

    for (const filename of files) {
      const migration = readMigration(filename);
      const applied = ledger.get(filename);
      if (applied) {
        await adoptOrVerifyApplied(filename, migration.checksum, applied, initialLedger);
        console.log(`[sql-migrate] skip ${filename}`);
        continue;
      }
      await applyFile(filename, migration.contents, migration.checksum);
    }
    console.log('[sql-migrate] up to date');
  } finally {
    await sql`SELECT pg_advisory_unlock(${advisoryLockKey})`.catch((error) => {
      console.error('[sql-migrate] failed to release advisory lock', error);
    });
  }
}

async function main(): Promise<void> {
  const ledger = await ensureLedger();
  const ledgerRows = await loadLedger(ledger);
  const compatibleFiles = selectMigrationFilesForLedger(listSqlMigrationFiles(), ledgerRows.keys());
  const boundedFiles = selectMigrationFilesThrough(compatibleFiles, throughMigration);

  if (statusOnly) {
    await printStatus(boundedFiles, ledgerRows);
    return;
  }
  await applyMigrations(boundedFiles, ledger, ledgerRows);
}

main()
  .catch((error) => {
    console.error('[sql-migrate] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
