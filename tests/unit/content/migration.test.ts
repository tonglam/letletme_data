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

  test('makes active publication unique by scope and revisioned', async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).toContain('UNIQUE (scope_key, revision)');
    expect(sql).toContain(
      ['WHERE status = ', 'active', ' AND servable'].join(String.fromCharCode(39)),
    );
  });
});
