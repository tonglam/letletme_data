import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(path, 'utf8');
const quote = String.fromCharCode(39);
const backslash = String.fromCharCode(92);

describe('P5 rehearsal contracts', () => {
  test('generates an approval-gated, exact activation rollback capsule', () => {
    const sql = read('sql/v3/generate-activation-rollback.sql');

    expect(sql).toStartWith(
      '\\set ON_ERROR_STOP on\n\\o /dev/null\n\\set QUIET 1\n\\pset tuples_only on',
    );
    expect(sql).toContain(
      `RAISE EXCEPTION ${quote}${quote}rollback_approval is required${quote}${quote}`,
    );
    expect(sql).not.toContain(`SELECT ${quote}${backslash}quit 3${quote}`);
    expect(sql).toContain(
      `WHEN ${quote}sql_migrations${quote} THEN ${quote}sql_migrations_v2${quote}`,
    );
    expect(sql).toContain('DELETE FROM public.sql_migrations WHERE filename NOT IN');
    expect(sql).toContain('REVOKE USAGE ON SCHEMA public FROM letletme_data_owner');
    expect(sql).toContain(`dependency_row.deptype IN (${quote}a${quote}, ${quote}i${quote})`);
    expect(sql).toContain('DO $rollback_ledger_postcondition$');
    expect(sql).toContain('DO $rollback_security_postcondition$');
    expect(sql).toContain('DO $rollback_postcondition$');
  });

  test('generates an exact non-destructive preactivation rollback capsule', () => {
    const sql = read('sql/v3/generate-preactivation-rollback.sql');

    expect(sql).toStartWith(
      '\\set ON_ERROR_STOP on\n\\o /dev/null\n\\set QUIET 1\n\\pset tuples_only on',
    );
    expect(sql).toContain('APPROVE_V3_PREACTIVATION_ROLLBACK ');
    expect(sql).toContain('preactivation rollback baseline v2 ledger changed');
    expect(sql).toContain('DELETE FROM public.sql_migrations WHERE filename NOT IN');
    expect(sql).toContain('REVOKE USAGE ON SCHEMA public FROM letletme_data_owner');
    expect(sql).toContain('preactivationRollbackMode');
    expect(sql).toContain('DO $preactivation_rollback_postcondition$');
    expect(sql).not.toContain('DROP SCHEMA');
    expect(sql).not.toContain('DROP TABLE');
  });

  test('generates exact two-phase post-cleanup B1 rollback capsules', () => {
    const sql = read('sql/v3/generate-postcleanup-rollback.sql');

    expect(sql).toStartWith(
      '\\set ON_ERROR_STOP on\n\\o /dev/null\n\\set QUIET 1\n\\pset tuples_only on',
    );
    expect(sql).toContain(`capsule_phase NOT IN (${quote}pre${quote}, ${quote}post${quote})`);
    expect(sql).toContain('APPROVE_V3_POSTCLEANUP_ROLLBACK ');
    expect(sql).toContain('legacy dump SHA-256 does not match this capsule');
    expect(sql).toContain('completed 0091, 0092, or 0093 boundary');
    expect(sql).toContain('cleanup_phase IS NULL OR cleanup_phase NOT IN');
    expect(sql).toContain('pg_restore --clean --if-exists');
    expect(sql).toContain(
      `pg_get_functiondef(${quote}ops.reject_v2_mutation()${quote}::regprocedure)`,
    );
    expect(sql).toContain('DO $postcleanup_public_restore_postcondition$');
    expect(sql).toContain('DO $normalize_public_schema_acl$');
    expect(sql).toContain('DO $postcleanup_ops_precondition$');
    expect(sql).toContain('DO $postcleanup_ops_postcondition$');
    expect(sql).toContain('DELETE FROM ops.schema_migrations');
    expect(sql).toContain('DELETE FROM ops.migration_objects');
    expect(sql).not.toContain('DROP SCHEMA');
  });

  test('limits B0 owner normalization to the approved isolated source scope', () => {
    const sql = read('sql/v3/p5-normalize-b0-ownership.sql');

    expect(sql).toContain(`current_database() !~ ${quote}^p5_${quote}`);
    expect(sql).toContain('public_relation_count <> 220');
    expect(sql).toContain('public_function_count <> 6');
    expect(sql).toContain('public_enum_count <> 20');
    expect(sql).toContain('Owned identity/serial sequences follow their table owner automatically');
    expect(sql).toContain('P5 B0 ownership normalization is incomplete');
  });

  test('keeps the P5 quality gate read-only and covers the agreed critical matrix', () => {
    const sql = read('sql/v3/validate-p5-quality.sql');

    expect(sql).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(sql).toContain(
      `${quote}1617${quote}, ${quote}1718${quote}, ${quote}1819${quote}, ` +
        `${quote}1920${quote}, ${quote}2021${quote}`,
    );
    expect(sql).toContain(
      `season_code = ${quote}2627${quote} AND lifecycle_state = ${quote}preseason${quote}`,
    );
    expect(sql).toContain(`column_name IN (${quote}event_id${quote}, ${quote}team_id${quote})`);
    expect(sql).toContain('P5 player value reconstruction mismatches');
    expect(sql).toContain('P5 post-cleanup player value evidence/current target mismatch');
    expect(sql).toContain(
      `legacy_drop_phase IN (${quote}physical_objects_removed${quote}, ${quote}complete${quote})`,
    );
    expect(sql).toContain('(SELECT count(*) FROM understat.matches) <> 4560');
    expect(sql).toContain('(SELECT count(*) FROM understat.player_match_stats) <> 129576');
    expect(sql).toContain('(SELECT count(*) FROM bridge.entity_links) <> 1909');
    expect(sql).toContain('P5 exact duplicate index contracts');
    expect(sql).toContain('P5 SECURITY DEFINER allowlist/search_path/execute contract failed');
    expect(sql).toContain('P5 dedicated Web auth capability role is missing');
    expect(sql).toContain('P5 dedicated Web auth runtime LOGIN is missing');
    expect(sql).toContain('P5 Web auth role % has Data/public relation privileges');
  });

  test('uses the exact 500 by 38 by 15 tournament benchmark workload', () => {
    const source = read('tests/integration/tournament-selection-benchmark.test.ts');

    expect(source).toContain('const ENTRY_COUNT = 500;');
    expect(source).toContain('const EVENT_COUNT = 38;');
    expect(source).toContain('const PICKS_PER_ENTRY = 15;');
    expect(source).toContain('ANALYZE competition.entry_event_picks');
    expect(source).toContain(
      `plannerStatistics: ${quote}explicitly-analyzed-after-bulk-fixture-load${quote}`,
    );
    expect(source).toContain('expect(refreshMs).toBeLessThanOrEqual(30_000)');
    expect(source).toContain('expect(selection.p95Ms).toBeLessThanOrEqual(100)');
    expect(source).toContain('expect(playerSummary.p95Ms).toBeLessThanOrEqual(150)');
    expect(source).toContain('maxMs: Number(selection.maxMs.toFixed(3))');
  });

  test('keeps reproducible P5 query-plan evidence for each reporting budget', () => {
    const sql = read('sql/v3/p5-performance-plans.sql');

    expect(sql).toContain('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)');
    expect(sql).toContain('p5-query:tournament-selection-read');
    expect(sql).toContain('p5-query:player-season-summary-read');
    expect(sql).toContain('p5-query:player-state-fpl-history');
    expect(sql).toContain('p5-query:player-state-understat-cohorts');
    expect(sql).toContain('pg_stat_user_indexes');
  });

  test('hashes every preserved B1 application/control schema outside public', () => {
    const sql = read('sql/v3/capture-b1-preserved-relation-hashes.sql');

    for (const schema of [
      'auth',
      'bauth',
      'drizzle',
      'ops',
      'storage',
      'supabase_functions',
      'supabase_migrations',
      'vault',
    ]) {
      expect(sql).toContain(`${quote}${schema}${quote}`);
    }
    expect(sql).not.toContain(`${quote}cron${quote}`);
    expect(sql).toContain(
      `relation_row.relkind IN (${quote}r${quote}, ${quote}p${quote}, ` +
        `${quote}m${quote}, ${quote}v${quote})`,
    );
  });

  test('distinguishes real frozen-owner grants from superuser pg_has_role semantics', () => {
    const activationValidation = read('sql/v3/validate-0090-activation.sql');
    const cleanupMigration = read('migrations/0093_finalize_v3_migration_ownership.sql');

    for (const sql of [activationValidation, cleanupMigration]) {
      expect(sql).toContain('FROM pg_auth_members membership');
      expect(sql).toContain('NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)');
      expect(sql).toContain('migration_login_inherits_frozen_owner');
    }
  });
});
