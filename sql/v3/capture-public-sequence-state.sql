\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '10s';

\pset tuples_only on
\pset format unaligned
\echo sequence,last_value,is_called,start_value,min_value,max_value,increment_by,cycle,cache_size

SELECT format(
  $command$
COPY (
  SELECT
    %L AS sequence,
    sequence_state.last_value,
    sequence_state.is_called,
    sequence_catalog.start_value,
    sequence_catalog.min_value,
    sequence_catalog.max_value,
    sequence_catalog.increment_by,
    sequence_catalog.cycle,
    sequence_catalog.cache_size
  FROM %I.%I sequence_state
  CROSS JOIN pg_sequences sequence_catalog
  WHERE sequence_catalog.schemaname = %L
    AND sequence_catalog.sequencename = %L
) TO STDOUT WITH (FORMAT csv);
$command$,
  namespace_row.nspname || '.' || relation_row.relname,
  namespace_row.nspname,
  relation_row.relname,
  namespace_row.nspname,
  relation_row.relname
)
FROM pg_class relation_row
JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
WHERE namespace_row.nspname = 'public'
  AND relation_row.relkind = 'S'
ORDER BY relation_row.relname
\gexec

COMMIT;
