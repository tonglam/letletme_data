import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const migrationsDir = process.env.MIGRATIONS_DIR ?? 'migrations';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

async function ensureLedger(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS sql_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
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

async function isApplied(filename: string): Promise<boolean> {
  const rows = await sql<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM sql_migrations
    WHERE filename = ${filename}
    LIMIT 1
  `;
  return rows.length > 0;
}

const advisoryLockKey = 912_883_471; // arbitrary 32-bit key for this migrator

async function markApplied(filename: string): Promise<void> {
  await sql`
    INSERT INTO sql_migrations (filename)
    VALUES (${filename})
    ON CONFLICT (filename) DO NOTHING
  `;
}

async function applyFile(filename: string): Promise<void> {
  const filePath = join(migrationsDir, filename);
  const contents = readFileSync(filePath, 'utf8');
  await sql.unsafe(contents);
  await markApplied(filename);
  console.log(`[sql-migrate] applied ${filename}`);
}

async function main(): Promise<void> {
  await ensureLedger();
  await sql`SELECT pg_advisory_lock(${advisoryLockKey})`;

  try {
    for (const filename of listSqlMigrationFiles()) {
      if (await isApplied(filename)) {
        console.log(`[sql-migrate] skip ${filename}`);
        continue;
      }

      await applyFile(filename);
    }

    console.log('[sql-migrate] up to date');
  } finally {
    await sql`SELECT pg_advisory_unlock(${advisoryLockKey})`.catch((error) => {
      console.error('[sql-migrate] failed to release advisory lock', error);
    });
  }
}

main()
  .catch((error) => {
    console.error('[sql-migrate] failed', error);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end();
  });
