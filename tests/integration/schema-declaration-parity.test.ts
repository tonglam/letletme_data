import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { expect, test } from 'bun:test';
import postgres from 'postgres';

const TARGET_SCHEMAS = ['fpl', 'competition', 'understat', 'bridge', 'ops', 'reporting']
  .map((schema) => `'${schema}'`)
  .join(',');
const SCHEMA_EXPORT_DATABASE_URL = process.env.SCHEMA_EXPORT_DATABASE_URL;
const parityTest =
  process.env.RUN_SCHEMA_DECLARATION_PARITY === '1' && SCHEMA_EXPORT_DATABASE_URL
    ? test
    : test.skip;

const SQL_OWNED_MATERIALIZED_VIEW_INDEXES = [
  'tournament_entry_event_summaries_entry_idx',
  'tournament_entry_event_summaries_grain_idx',
  'tournament_entry_event_summaries_rank_idx',
  'tournament_selection_stats_captain_idx',
  'tournament_selection_stats_grain_idx',
  'tournament_selection_stats_selected_idx',
  'tournament_selection_stats_transfer_in_idx',
] as const;

const SIGNATURE_QUERIES = {
  relations: `
    SELECT jsonb_build_array(namespace.nspname, relation.relname, relation.relkind)::text AS signature
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN (${TARGET_SCHEMAS})
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm')
    ORDER BY namespace.nspname, relation.relname, relation.relkind
  `,
  columns: `
    SELECT jsonb_build_array(
      namespace.nspname,
      relation.relname,
      attribute.attnum,
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod),
      attribute.attnotnull,
      attribute.attidentity,
      COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), '')
    )::text AS signature
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname IN (${TARGET_SCHEMAS})
      AND relation.relkind IN ('r', 'p', 'v', 'm')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY namespace.nspname, relation.relname, attribute.attnum
  `,
  enums: `
    SELECT jsonb_build_array(
      namespace.nspname,
      type.typname,
      enum.enumsortorder,
      enum.enumlabel
    )::text AS signature
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    JOIN pg_enum enum ON enum.enumtypid = type.oid
    WHERE namespace.nspname IN (${TARGET_SCHEMAS})
    ORDER BY namespace.nspname, type.typname, enum.enumsortorder
  `,
  sequences: `
    SELECT jsonb_build_array(
      schemaname,
      sequencename,
      data_type,
      start_value,
      min_value,
      max_value,
      increment_by,
      cycle,
      cache_size
    )::text AS signature
    FROM pg_sequences
    WHERE schemaname IN (${TARGET_SCHEMAS})
    ORDER BY schemaname, sequencename
  `,
  views: `
    SELECT jsonb_build_array(
      namespace.nspname,
      relation.relname,
      relation.relkind,
      pg_get_viewdef(relation.oid, true)
    )::text AS signature
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'reporting'
      AND relation.relkind IN ('v', 'm')
    ORDER BY relation.relname
  `,
} as const;

type ConstraintRow = {
  schema_name: string;
  relation_name: string;
  constraint_name: string;
  constraint_type: string;
  definition: string;
};

type IndexRow = {
  schema_name: string;
  relation_name: string;
  index_name: string;
  is_unique: boolean;
  nulls_not_distinct: boolean;
  predicate: string;
  definition: string;
};

async function readRows<T extends Record<string, unknown>>(
  client: postgres.Sql,
  query: string,
): Promise<T[]> {
  const rows = await client.unsafe<T[]>(query);
  return rows.map((row) => ({ ...row }));
}

async function readSignatures(client: postgres.Sql, query: string): Promise<string[]> {
  const rows = await readRows<{ signature: string }>(client, query);
  return rows.map((row) => row.signature);
}

async function readConstraints(client: postgres.Sql): Promise<ConstraintRow[]> {
  return readRows<ConstraintRow>(
    client,
    `
      SELECT
        namespace.nspname AS schema_name,
        relation.relname AS relation_name,
        constraint_row.conname AS constraint_name,
        constraint_row.contype AS constraint_type,
        pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN (${TARGET_SCHEMAS})
      ORDER BY namespace.nspname, relation.relname, constraint_row.conname
    `,
  );
}

async function readIndexes(client: postgres.Sql): Promise<IndexRow[]> {
  return readRows<IndexRow>(
    client,
    `
      SELECT
        namespace.nspname AS schema_name,
        table_relation.relname AS relation_name,
        index_relation.relname AS index_name,
        index_row.indisunique AS is_unique,
        index_row.indnullsnotdistinct AS nulls_not_distinct,
        COALESCE(pg_get_expr(index_row.indpred, index_row.indrelid), '') AS predicate,
        regexp_replace(
          pg_get_indexdef(index_row.indexrelid),
          ' ON [^ ]+ USING ',
          ' ON <REL> USING '
        ) AS definition
      FROM pg_index index_row
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname IN (${TARGET_SCHEMAS})
        AND NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_row
          WHERE constraint_row.conindid = index_row.indexrelid
        )
      ORDER BY namespace.nspname, table_relation.relname, index_relation.relname
    `,
  );
}

function normalizeConstraint(row: ConstraintRow): ConstraintRow {
  if (
    row.schema_name === 'ops' &&
    row.relation_name === 'sync_runs' &&
    row.definition ===
      'FOREIGN KEY (publication_id) REFERENCES ops.dataset_publications(publication_id)'
  ) {
    return { ...row, constraint_name: 'sync_runs_publication_fk' };
  }
  return row;
}

function normalizeIndex(row: IndexRow): IndexRow {
  if (row.index_name !== 'dataset_publications_one_active_scope_idx') {
    return row;
  }
  return {
    ...row,
    nulls_not_distinct: false,
    definition: row.definition.replace(' NULLS NOT DISTINCT', ''),
  };
}

parityTest(
  'keeps the Drizzle declaration equal to the migrated catalog',
  async () => {
    if (!SCHEMA_EXPORT_DATABASE_URL) {
      throw new Error('SCHEMA_EXPORT_DATABASE_URL is required for schema declaration parity');
    }
    if (!/localhost|127\.0\.0\.1|_test/i.test(SCHEMA_EXPORT_DATABASE_URL)) {
      throw new Error('SCHEMA_EXPORT_DATABASE_URL must point at disposable test infrastructure');
    }

    const migrated = postgres(process.env.DATABASE_URL!, { max: 1 });
    const exported = postgres(SCHEMA_EXPORT_DATABASE_URL, { max: 1 });

    try {
      for (const query of Object.values(SIGNATURE_QUERIES)) {
        expect(await readSignatures(exported, query)).toEqual(
          await readSignatures(migrated, query),
        );
      }

      const migratedConstraints = await readConstraints(migrated);
      const exportedConstraints = await readConstraints(exported);
      expect(
        migratedConstraints.find((row) => row.constraint_name === 'sync_runs_publication_fk'),
      ).toBeDefined();
      expect(
        exportedConstraints.find(
          (row) =>
            row.constraint_name ===
            'sync_runs_publication_id_dataset_publications_publication_id_fk',
        ),
      ).toBeDefined();
      expect(exportedConstraints.map(normalizeConstraint)).toEqual(
        migratedConstraints.map(normalizeConstraint),
      );

      const migratedIndexes = await readIndexes(migrated);
      const exportedIndexes = await readIndexes(exported);
      const sqlOwnedNames = new Set<string>(SQL_OWNED_MATERIALIZED_VIEW_INDEXES);
      expect(
        migratedIndexes
          .filter((row) => sqlOwnedNames.has(row.index_name))
          .map((row) => row.index_name),
      ).toEqual([...SQL_OWNED_MATERIALIZED_VIEW_INDEXES]);
      expect(exportedIndexes.filter((row) => sqlOwnedNames.has(row.index_name))).toHaveLength(0);

      const migratedActive = migratedIndexes.find(
        (row) => row.index_name === 'dataset_publications_one_active_scope_idx',
      );
      const exportedActive = exportedIndexes.find(
        (row) => row.index_name === 'dataset_publications_one_active_scope_idx',
      );
      expect(migratedActive?.nulls_not_distinct).toBe(true);
      expect(exportedActive?.nulls_not_distinct).toBe(false);

      expect(
        exportedIndexes.filter((row) => !sqlOwnedNames.has(row.index_name)).map(normalizeIndex),
      ).toEqual(
        migratedIndexes.filter((row) => !sqlOwnedNames.has(row.index_name)).map(normalizeIndex),
      );
    } finally {
      await Promise.all([migrated.end(), exported.end()]);
    }
  },
  30_000,
);
