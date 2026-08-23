import { describe, expect, test } from 'bun:test';

const migrationPath = new URL(
  '../../../migrations/0010_content_week_foundation.sql',
  import.meta.url,
);

describe('Briefing content migration contract', () => {
  test('keeps raw editorial tables writer-only and exposes only compiled reads to GraphQL', async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).toContain('CREATE SCHEMA content');
    expect(sql).toContain('CREATE TABLE content.acquisition_checkpoints');
    expect(sql).toContain('CREATE TABLE content.acquisition_budgets');
    expect(sql).toContain('CREATE TABLE content.acquisition_run_x_traces');
    expect(sql).toContain('CREATE TABLE content.acquisition_costs');
    expect(sql).toContain('CREATE TABLE content.claims');
    expect(sql).toContain('CREATE TABLE content.publication_dependencies');
    expect(sql).toContain('CREATE TABLE content.editorial_actions');
    expect(sql).toContain(
      'GRANT SELECT ON content.briefing_active_publication TO letletme_graphql_reader',
    );
    expect(sql).toContain(
      'GRANT SELECT ON content.publication_payloads TO letletme_graphql_reader',
    );
    expect(sql).not.toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA content\n  GRANT SELECT ON TABLES TO letletme_graphql_reader',
    );
  });

  test('moves mutation coordination and frozen publication state into PostgreSQL', async () => {
    const safety = await Bun.file(
      new URL('../../../migrations/0017_core_mutation_safety.sql', import.meta.url),
    ).text();
    const freeze = await Bun.file(
      new URL('../../../migrations/0018_content_publication_freeze.sql', import.meta.url),
    ).text();
    expect(safety).toContain('CREATE TABLE ops.mutation_scopes');
    expect(safety).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE ops.mutation_scopes');
    expect(safety).toContain(String.raw`'^LL-([0-9A-F]{6}|[0-9A-F]{12})$'`);
    expect(freeze).toContain('CREATE TABLE content.week_edition_snapshots');
    expect(freeze).toContain('CREATE TABLE content.week_edition_source_runs');
    expect(freeze).toContain('content_week_edition_snapshots_immutable');
    expect(freeze).toContain('content_week_edition_items_draft_only');
    expect(freeze).toContain('REVOKE UPDATE, DELETE ON content.week_edition_snapshots');
  });

  test('keeps private screenshot migration additive and key-only', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0015_bug_report_private_screenshots.sql', import.meta.url),
    ).text();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS screenshot_object_key');
    expect(sql).toContain('bug_reports_submission_id_key');
    expect(sql).toContain('bug_reports_screenshot_object_key_format');
    expect(sql).toContain('The legacy screenshot_url column remains');
  });

  test('binds screenshot object ownership to submission ids and prevents duplicate keys', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0021_bug_report_screenshot_ownership.sql', import.meta.url),
    ).text();
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS bug_reports_screenshot_object_key_format');
    expect(sql).toContain('submission_id::text');
    expect(sql).toContain('jpg|png|webp|gif');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS bug_reports_screenshot_object_key_key',
    );
  });

  test('locks freeze parents while checking draft-only child writes', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0022_content_freeze_parent_locks.sql', import.meta.url),
    ).text();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION content.assert_draft_week_edition_items()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION content.assert_draft_story_localization()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION content.assert_draft_story_evidence()');
    expect(sql.match(/FOR UPDATE/g)?.length).toBe(3);
  });

  test('binds submission-id replays to a canonical request hash', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0019_bug_report_submission_request_hash.sql', import.meta.url),
    ).text();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS submission_request_hash');
    expect(sql).toContain('bug_reports_submission_request_hash_format');
  });

  test('keeps FINAL_90 calls in a separate phase budget ledger', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0020_content_acquisition_phase_budgets.sql', import.meta.url),
    ).text();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS budget_scope');
    expect(sql).toContain('content_acquisition_budgets_scope_check');
    expect(sql).toContain('content_acquisition_budgets_unique_scope_day');
    expect(sql).toContain('final90');
  });

  test('distinguishes confirmed queued acquisition reservations from enqueue failures', async () => {
    const sql = await Bun.file(
      new URL(
        '../../../migrations/0023_content_acquisition_enqueue_confirmation.sql',
        import.meta.url,
      ),
    ).text();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS enqueue_confirmed_at');
  });

  test('indexes every receipt kind handled by the triggered planner', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0030_content_article_planner_index.sql', import.meta.url),
    ).text();
    expect(sql).toContain(
      'content_kind IN (|ARTICLE|, |EPISODE|, |VIDEO|)'.replaceAll('|', String.fromCharCode(39)),
    );
  });

  test('removes the legacy cross-kind receipt identity constraint', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0031_content_receipt_identity_constraint.sql', import.meta.url),
    ).text();
    expect(sql).toContain('DROP CONSTRAINT content_source_receipts_source_external_key');
  });

  test('makes active publication unique by scope and revisioned', async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).toContain('UNIQUE (scope_key, revision)');
    expect(sql).toContain(
      ['WHERE status = ', 'active', ' AND servable'].join(String.fromCharCode(39)),
    );
  });

  test('keeps host-runner probe reservations independently transitionable', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0035_content_x_probe_reservations.sql', import.meta.url),
    ).text();
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS content_acquisition_budget_reservations_run_ledger_key',
    );
  });

  test('archives X media behind a bounded gate without exposing raw assets to GraphQL', async () => {
    const sql = await Bun.file(
      new URL('../../../migrations/0037_content_source_media_archive.sql', import.meta.url),
    ).text();
    expect(sql).toContain('CREATE TABLE content.source_media_gates');
    expect(sql).toContain('CREATE TABLE content.source_media_items');
    expect(sql).toContain('CREATE TABLE content.source_media_assets');
    expect(sql).toContain(String.raw`'receipt.media.updated.v1'`);
    expect(sql).toContain('INSERT INTO content.source_media_gates');
    expect(sql).toContain('available_at = GREATEST(outbox.available_at, gate.release_deadline_at)');
    expect(sql).toContain('content_source_media_gates_identity_immutable');
    expect(sql).toContain('content_source_media_assets_facts_immutable');
    expect(sql).toContain('content_source_media_items_evidence_immutable');
    expect(sql).toContain('content_source_media_gates_receipt_identity_valid');
    expect(sql).toContain('content_source_media_items_archive_valid');
    expect(sql).toContain('IF OLD.available_at IS NOT NULL AND (');
    expect(sql).toContain('AND asset.upload_lease_owner IS NULL');
    expect(sql).toContain(String.raw`OLD.archive_status = 'ARCHIVED'`);
    expect(sql).toContain('REVOKE ALL ON content.source_media_assets FROM letletme_graphql_reader');
    expect(sql).toContain('REVOKE DELETE ON content.source_media_items FROM letletme_data_writer');
  });
});
