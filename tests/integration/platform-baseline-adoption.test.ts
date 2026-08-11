import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

import {
  adoptProductionPlatformBaseline,
  PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
} from '../../scripts/platform-baseline-adoption';
import {
  fingerprintPlatformDataManifest,
  loadPlatformDataManifest,
} from '../../scripts/platform-data-contract';

const adoptionTest = process.env.RUN_BASELINE_ADOPTION_INTEGRATION === '1' ? test : test.skip;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = postgres(databaseUrl, { max: 1 });
const baselineFilename = '0000_platform_baseline.sql';
const baselineContents = await Bun.file(`migrations/${baselineFilename}`).text();
const baselineChecksum = createHash('sha256').update(baselineContents, 'utf8').digest('hex');
const productionLedgerFixture = await Bun.file(
  'tests/fixtures/platform-production-ledger.sql',
).text();
const fixtureRoleNames = [
  'adoption_runtime',
  'letletme_data_runtime',
  'letletme_graphql_runtime',
  'letletme_web_auth',
  'letletme_web_runtime',
] as const;
const createdFixtureRoles = new Set<string>();

async function currentDataFingerprint(): Promise<string> {
  return fingerprintPlatformDataManifest(await loadPlatformDataManifest(sql));
}

async function expectCanonicalLedger(): Promise<void> {
  const rows = await sql<{ filename: string; checksum: string }[]>`
    SELECT filename, checksum FROM ops.schema_migrations ORDER BY filename
  `;
  expect(rows.map(({ filename, checksum }) => ({ filename, checksum }))).toEqual([
    { filename: baselineFilename, checksum: baselineChecksum },
  ]);
}

if (process.env.RUN_BASELINE_ADOPTION_INTEGRATION === '1') {
  beforeAll(async () => {
    await sql.unsafe(`
      DO $$
      BEGIN
        CREATE ROLE anon NOLOGIN;
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END
      $$;
    `);
    const existingRoles = await sql<{ rolname: string }[]>`
      SELECT rolname
      FROM pg_roles
      WHERE rolname = ANY(${fixtureRoleNames as unknown as string[]})
    `;
    const existingRoleNames = new Set(existingRoles.map(({ rolname }) => rolname));
    for (const roleName of fixtureRoleNames) {
      if (existingRoleNames.has(roleName)) continue;
      await sql.unsafe(`CREATE ROLE "${roleName}" NOLOGIN`);
      createdFixtureRoles.add(roleName);
    }
    await sql`GRANT letletme_data_writer TO letletme_data_runtime`;
    await sql`GRANT letletme_graphql_reader TO letletme_graphql_runtime`;
    await sql`GRANT letletme_web_auth TO letletme_web_runtime`;
    await sql`REFRESH MATERIALIZED VIEW reporting.tournament_entry_event_summaries`;
    await sql`REFRESH MATERIALIZED VIEW reporting.tournament_selection_stats`;
    await sql`DROP INDEX IF EXISTS competition.tournament_knockouts_season_fk_idx`;
    await sql`DROP INDEX IF EXISTS ops.dataset_publications_season_fk_idx`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION reporting.refresh_tournament_entry_event_summaries()
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(73001, 2);
    REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_entry_event_summaries;
  END
  $function$;
    `);
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION reporting.refresh_tournament_selection_stats()
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(73001, 1);
    REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_selection_stats;
  END
  $function$;
    `);
  });
}

afterAll(async () => {
  for (const roleName of [...createdFixtureRoles].reverse()) {
    await sql.unsafe(`DROP ROLE IF EXISTS "${roleName}"`);
  }
  await sql.end();
});

describe('canonical platform baseline adoption', () => {
  adoptionTest(
    'replaces the accepted production ledger without changing business data or sequences',
    async () => {
      const dataFingerprint = await currentDataFingerprint();
      await sql.begin(async (transaction) => {
        await transaction`DELETE FROM ops.schema_migrations`;
        await transaction.unsafe(productionLedgerFixture);
        await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
          ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
          dataFingerprint,
        });
      });

      await expectCanonicalLedger();
      expect(await currentDataFingerprint()).toBe(dataFingerprint);
      const indexes = await sql<{ name: string }[]>`
        SELECT indexname AS name
        FROM pg_indexes
        WHERE (schemaname, indexname) IN (
          ('competition', 'tournament_knockouts_season_fk_idx'),
          ('ops', 'dataset_publications_season_fk_idx')
        )
        ORDER BY indexname
      `;
      expect(indexes.map(({ name }) => ({ name }))).toEqual([
        { name: 'dataset_publications_season_fk_idx' },
        { name: 'tournament_knockouts_season_fk_idx' },
      ]);
      const [ownerMembership] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_auth_members membership
          JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
          JOIN pg_roles member_role ON member_role.oid = membership.member
          WHERE granted_role.rolname = 'letletme_data_owner'
            AND member_role.rolname = current_user
        ) AS exists
      `;
      expect(ownerMembership?.exists).toBe(true);
    },
    60_000,
  );

  adoptionTest(
    'rolls back when the production ledger checksum differs',
    async () => {
      const dataFingerprint = await currentDataFingerprint();
      await expect(
        sql.begin(async (transaction) => {
          await transaction`DELETE FROM ops.schema_migrations`;
          await transaction.unsafe(productionLedgerFixture);
          await transaction`
            UPDATE ops.schema_migrations
            SET checksum = repeat('0', 64)
            WHERE filename = '0095_canonicalize_platform_contract.sql'
          `;
          await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
            ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
            dataFingerprint,
          });
        }),
      ).rejects.toThrow('migration ledger');
      await expectCanonicalLedger();
    },
    60_000,
  );

  adoptionTest(
    'rolls back on extra schema objects or ACL drift',
    async () => {
      const dataFingerprint = await currentDataFingerprint();
      await expect(
        sql.begin(async (transaction) => {
          await transaction`DELETE FROM ops.schema_migrations`;
          await transaction.unsafe(productionLedgerFixture);
          await transaction`CREATE TABLE fpl.unexpected_relation (id integer PRIMARY KEY)`;
          await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
            ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
            dataFingerprint,
          });
        }),
      ).rejects.toThrow('schema fingerprint mismatch');
      await expectCanonicalLedger();

      await expect(
        sql.begin(async (transaction) => {
          await transaction`DELETE FROM ops.schema_migrations`;
          await transaction.unsafe(productionLedgerFixture);
          await transaction`GRANT SELECT ON fpl.seasons TO anon`;
          await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
            ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
            dataFingerprint,
          });
        }),
      ).rejects.toThrow('schema fingerprint mismatch');
      await expectCanonicalLedger();

      await expect(
        sql.begin(async (transaction) => {
          await transaction`DELETE FROM ops.schema_migrations`;
          await transaction.unsafe(productionLedgerFixture);
          await transaction`GRANT letletme_data_writer TO anon`;
          await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
            ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
            dataFingerprint,
          });
        }),
      ).rejects.toThrow('Unexpected capability role membership');
      await expectCanonicalLedger();

      await expect(
        sql.begin(async (transaction) => {
          await transaction`DELETE FROM ops.schema_migrations`;
          await transaction.unsafe(productionLedgerFixture);
          await transaction`GRANT letletme_data_writer TO adoption_runtime`;
          await transaction`GRANT adoption_runtime TO anon`;
          await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
            ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
            dataFingerprint,
          });
        }),
      ).rejects.toThrow('Unexpected capability role membership');
      await expectCanonicalLedger();
    },
    60_000,
  );

  adoptionTest(
    'rolls back on business-row or sequence drift',
    async () => {
      const dataFingerprint = await currentDataFingerprint();
      await expect(
        sql.begin(async (transaction) => {
          await transaction`DELETE FROM ops.schema_migrations`;
          await transaction.unsafe(productionLedgerFixture);
          await transaction`
            INSERT INTO fpl.seasons (
              season_id,
              season_code,
              display_name,
              start_year,
              end_year,
              lifecycle_state
            ) VALUES (3000, '0001', 'fixture-drift', 3000, 3001, 'reference_only')
          `;
          await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
            ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
            dataFingerprint,
          });
        }),
      ).rejects.toThrow('data fingerprint mismatch');
      await expectCanonicalLedger();

      const [sequenceBefore] = await sql<{ last_value: string; is_called: boolean }[]>`
        SELECT last_value::text, is_called FROM ops.dataset_publication_revisions
      `;
      if (!sequenceBefore) throw new Error('Missing dataset publication revision sequence');
      const driftedValue = (BigInt(sequenceBefore.last_value) + 1n).toString();

      try {
        await expect(
          sql.begin(async (transaction) => {
            await transaction`DELETE FROM ops.schema_migrations`;
            await transaction.unsafe(productionLedgerFixture);
            await transaction`
              SELECT setval('ops.dataset_publication_revisions', ${driftedValue}::bigint, true)
            `;
            await adoptProductionPlatformBaseline(transaction, baselineFilename, baselineChecksum, {
              ...PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
              dataFingerprint,
            });
          }),
        ).rejects.toThrow('data fingerprint mismatch');
      } finally {
        await sql`
          SELECT setval(
            'ops.dataset_publication_revisions',
            ${sequenceBefore.last_value}::bigint,
            ${sequenceBefore.is_called}
          )
        `;
      }
      await expectCanonicalLedger();
    },
    60_000,
  );
});
