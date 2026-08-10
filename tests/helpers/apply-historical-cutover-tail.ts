/* eslint-disable no-console -- CI fixture runner */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import postgres from 'postgres';

import { getSqlMigrationExecutionContents } from '../../scripts/sql-migration-compatibility';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = postgres(databaseUrl, { max: 1 });
const files = [
  '0091_drop_v2_reporting_and_rpcs.sql',
  '0092_drop_v2_tables_partitions_triggers.sql',
  '0093_finalize_v3_migration_ownership.sql',
] as const;
const approval = 'APPROVE_V3_LEGACY_DROP v3-20260808T160008Z-b9eddc0';

try {
  for (const filename of files) {
    const contents = readFileSync(`migrations/${filename}`, 'utf8');
    const checksum = createHash('sha256').update(contents, 'utf8').digest('hex');
    const executionContents = getSqlMigrationExecutionContents(filename, contents);
    await sql.begin(async (transaction) => {
      await transaction`SELECT set_config('lock_timeout', '5s', true)`;
      await transaction`SELECT set_config('statement_timeout', '5min', true)`;
      await transaction`SELECT set_config('letletme.v3_legacy_drop_approval', ${approval}, true)`;
      await transaction.unsafe(executionContents);
      await transaction`
        INSERT INTO ops.schema_migrations (filename, checksum)
        VALUES (${filename}, ${checksum})
      `;
    });
    console.log(`[historical-cutover-fixture] applied ${filename}`);
  }
} finally {
  await sql.end();
}
