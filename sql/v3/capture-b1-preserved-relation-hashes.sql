\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15min';
SET LOCAL lock_timeout = '10s';

\pset tuples_only on
\pset format unaligned
\echo relation,row_count,sha256

SELECT format(
  $command$
COPY (
  SELECT
    %L AS relation,
    count(*)::bigint AS row_count,
    encode(
      sha256(convert_to(coalesce(string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')),
      'hex'
    ) AS sha256
  FROM (
    SELECT encode(
      sha256(convert_to(to_jsonb(source_row)::text, 'UTF8')),
      'hex'
    ) AS row_hash
    FROM %I.%I AS source_row
  ) AS hashed_rows
) TO STDOUT WITH (FORMAT csv);
$command$,
  namespace_row.nspname || '.' || relation_row.relname,
  namespace_row.nspname,
  relation_row.relname
)
FROM pg_class relation_row
JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
WHERE namespace_row.nspname IN (
    'auth',
    'bauth',
    'drizzle',
    'ops',
    'storage',
    'supabase_functions',
    'supabase_migrations',
    'vault'
  )
  AND relation_row.relkind IN ('r', 'p', 'm', 'v')
ORDER BY namespace_row.nspname, relation_row.relkind, relation_row.relname
\gexec

COMMIT;
