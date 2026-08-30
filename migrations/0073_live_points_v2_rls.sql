-- The V2 checkpoint relations were introduced after the generic application
-- RLS migration. Apply the same backend-only policy contract explicitly so a
-- new table cannot become an unprotected exception.
DO $migration$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('competition', 'live_points_publication_checkpoints'),
      ('competition', 'entry_event_pick_repairs'),
      ('competition', 'entry_event_pick_heads')
    ) AS listed(schema_name, table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.schema_name, target.table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polrelid = to_regclass(format('%I.%I', target.schema_name, target.table_name))
        AND polname = 'letletme_data_writer_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY letletme_data_writer_all ON %I.%I FOR ALL TO letletme_data_writer USING (true) WITH CHECK (true)',
        target.schema_name, target.table_name
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polrelid = to_regclass(format('%I.%I', target.schema_name, target.table_name))
        AND polname = 'letletme_graphql_reader_select'
    ) THEN
      EXECUTE format(
        'CREATE POLICY letletme_graphql_reader_select ON %I.%I FOR SELECT TO letletme_graphql_reader USING (true)',
        target.schema_name, target.table_name
      );
    END IF;
  END LOOP;
END
$migration$;
