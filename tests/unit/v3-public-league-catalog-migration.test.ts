import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(path, 'utf8');
const quote = String.fromCharCode(39);

describe('optional GraphQL public-league catalog cutover', () => {
  test('freezes the optional catalog as an exact v2 physical relation', () => {
    const activation = read('migrations/0090_activate_v3_and_freeze_v2.sql');

    expect(activation).toContain(`SELECT ${quote}public_league_trends_catalog${quote}::name`);
    expect(activation).toContain(
      `WHERE to_regclass(${quote}public.public_league_trends_catalog${quote}) IS NOT NULL`,
    );
    expect(activation).toContain(
      `${quote}v2PhysicalRelationCount${quote}, ` +
        '(SELECT count(*) FROM v3_legacy_physical_relations)',
    );
    expect(activation).toContain(
      'IF trigger_count <> (SELECT count(*) FROM v3_legacy_physical_relations)',
    );
    expect(activation).toContain(
      'GRANT SELECT ON v3_legacy_physical_relations TO letletme_data_owner',
    );
    expect(activation).not.toContain(`${quote}v2PhysicalRelationCount${quote}, 192`);
    expect(activation).not.toContain('expected 192 v2 mutation fences');
  });

  test('copies through a temporary frozen-owner membership and releases it', () => {
    const migration = read('migrations/0090_zz_add_public_league_trends.sql');
    const targetCreated = migration.indexOf('CREATE TABLE competition.public_league_trends');
    const resetToMigrationLogin = migration.indexOf('RESET ROLE;', targetCreated);
    const assumeOwner = migration.indexOf('DO $assume_optional_catalog_owner$');
    const copy = migration.indexOf('DO $copy_graphql_catalog$');
    const releaseOwner = migration.indexOf('DO $release_optional_catalog_owner$');
    const restoreDataOwner = migration.indexOf('SET LOCAL ROLE letletme_data_owner;', releaseOwner);

    expect(resetToMigrationLogin).toBeGreaterThan(targetCreated);
    expect(assumeOwner).toBeGreaterThan(resetToMigrationLogin);
    expect(copy).toBeGreaterThan(assumeOwner);
    expect(releaseOwner).toBeGreaterThan(copy);
    expect(restoreDataOwner).toBeGreaterThan(releaseOwner);
    expect(migration).toContain('GRANT letletme_v2_frozen_owner TO %I');
    expect(migration).toContain('REVOKE letletme_v2_frozen_owner FROM %I');
    expect(migration).toContain('FROM public.public_league_trends_catalog catalog');
  });

  test('keeps the optional catalog in the exact approval-gated cleanup scope', () => {
    const reportingCleanup = read('migrations/0091_drop_v2_reporting_and_rpcs.sql');
    const physicalCleanup = read('migrations/0092_drop_v2_tables_partitions_triggers.sql');

    expect(reportingCleanup).toContain(
      `to_regprocedure(${quote}public.touch_public_league_trends_catalog_updated_at()${quote})`,
    );
    expect(reportingCleanup).toContain(
      'DROP TRIGGER public_league_trends_catalog_touch_updated_at',
    );
    expect(reportingCleanup).toContain(
      'DROP FUNCTION public.touch_public_league_trends_catalog_updated_at()',
    );
    expect(reportingCleanup).toContain(
      'public.search_players_for_picker(text,integer,integer,integer,integer,integer,integer)',
    );
    expect(physicalCleanup.match(/SELECT 'public_league_trends_catalog'::name/g)).toHaveLength(2);
    expect(physicalCleanup).toContain('(SELECT count(*) FROM v3_legacy_physical_relations) - 2');
    expect(physicalCleanup).not.toContain(
      `(${quote}0092_drop_v2_physical_relations${quote}, ` +
        `${quote}public v2 physical relations${quote}, 190::bigint)`,
    );
  });

  test('makes activation validation and rollback cardinalities catalog-aware', () => {
    const activationValidation = read('sql/v3/validate-0090-activation.sql');
    const rollback = read('sql/v3/generate-postcleanup-rollback.sql');

    expect(activationValidation).toContain(
      `to_regclass(${quote}public.public_league_trends_catalog${quote}) IS NULL`,
    );
    expect(rollback.match(/public\.public_league_trends_catalog/g)).toHaveLength(7);
    expect(rollback).toContain('public_physical_count = 192 + CASE');
  });
});
