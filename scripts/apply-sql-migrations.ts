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

function listSqlMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .filter((name) => Number(name.slice(0, 4)) > 5);
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

async function markApplied(filename: string): Promise<void> {
  await sql`
    INSERT INTO sql_migrations (filename)
    VALUES (${filename})
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

  for (const filename of listSqlMigrationFiles()) {
    if (await isApplied(filename)) {
      console.log(`[sql-migrate] skip ${filename}`);
      continue;
    }

    await applyFile(filename);
  }

  console.log('[sql-migrate] up to date');
}

main()
  .catch((error) => {
    console.error('[sql-migrate] failed', error);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end();
  });
