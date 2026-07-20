/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';

const migrationsDir = process.env.MIGRATIONS_DIR ?? 'migrations';
const databaseUrl = process.env.DATABASE_URL;
const statusOnly = process.argv.includes('--status');

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
const advisoryLockKey = 912_883_471;

type LedgerRow = { filename: string; checksum: string | null; applied_at: Date };

const checksum = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

async function ensureLedger(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS sql_migrations (
      filename text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE sql_migrations ADD COLUMN IF NOT EXISTS checksum text`;
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

async function loadLedger(): Promise<Map<string, LedgerRow>> {
  const rows = await sql<LedgerRow[]>`
    SELECT filename, checksum, applied_at
    FROM sql_migrations
    ORDER BY filename
  `;
  return new Map(rows.map((row) => [row.filename, row]));
}

async function adoptOrVerifyApplied(
  filename: string,
  expectedChecksum: string,
  row: LedgerRow,
): Promise<void> {
  if (row.checksum === null) {
    await sql`
      UPDATE sql_migrations
      SET checksum = ${expectedChecksum}
      WHERE filename = ${filename} AND checksum IS NULL
    `;
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
  await sql.begin(async (tx) => {
    await tx.unsafe(contents);
    await tx`
      INSERT INTO sql_migrations (filename, checksum)
      VALUES (${filename}, ${digest})
      ON CONFLICT (filename) DO NOTHING
    `;
  });
  console.log(`[sql-migrate] applied ${filename}`);
}

async function printStatus(files: string[], ledger: Map<string, LedgerRow>): Promise<void> {
  let invalid = false;
  const local = new Set(files);

  for (const filename of files) {
    const migration = readMigration(filename);
    const row = ledger.get(filename);
    if (!row) {
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

  for (const filename of ledger.keys()) {
    if (!local.has(filename)) {
      console.log(`missing  ${filename} (ledgered file absent)`);
      invalid = true;
    }
  }

  if (invalid) process.exitCode = 1;
}

async function applyMigrations(files: string[]): Promise<void> {
  await sql`SELECT pg_advisory_lock(${advisoryLockKey})`;
  try {
    const ledger = await loadLedger();
    const local = new Set(files);
    const missing = [...ledger.keys()].filter((filename) => !local.has(filename));
    if (missing.length > 0) {
      throw new Error(`ledgered migration files are missing: ${missing.join(', ')}`);
    }

    for (const filename of files) {
      const migration = readMigration(filename);
      const applied = ledger.get(filename);
      if (applied) {
        await adoptOrVerifyApplied(filename, migration.checksum, applied);
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
  await ensureLedger();
  const files = listSqlMigrationFiles();
  if (statusOnly) {
    await printStatus(files, await loadLedger());
    return;
  }
  await applyMigrations(files);
}

main()
  .catch((error) => {
    console.error('[sql-migrate] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
