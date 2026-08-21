-- Official FPL entry histories can reach further back than the analytical
-- season catalog. These rows provide only the canonical foreign-key identity
-- needed to retain those historical profile records.
INSERT INTO fpl.seasons (
  season_id,
  season_code,
  display_name,
  start_year,
  end_year,
  lifecycle_state,
  is_current,
  source_metadata
)
VALUES
  (
    2006, '0607', '2006/07', 2006, 2007, 'reference_only', false,
    '{"source":"fpl_entry_history"}'::jsonb
  ),
  (
    2007, '0708', '2007/08', 2007, 2008, 'reference_only', false,
    '{"source":"fpl_entry_history"}'::jsonb
  ),
  (
    2008, '0809', '2008/09', 2008, 2009, 'reference_only', false,
    '{"source":"fpl_entry_history"}'::jsonb
  ),
  (
    2009, '0910', '2009/10', 2009, 2010, 'reference_only', false,
    '{"source":"fpl_entry_history"}'::jsonb
  ),
  (
    2010, '1011', '2010/11', 2010, 2011, 'reference_only', false,
    '{"source":"fpl_entry_history"}'::jsonb
  )
ON CONFLICT (season_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (2006::smallint, '0607', '2006/07', 2006::smallint, 2007::smallint),
        (2007::smallint, '0708', '2007/08', 2007::smallint, 2008::smallint),
        (2008::smallint, '0809', '2008/09', 2008::smallint, 2009::smallint),
        (2009::smallint, '0910', '2009/10', 2009::smallint, 2010::smallint),
        (2010::smallint, '1011', '2010/11', 2010::smallint, 2011::smallint)
    ) AS expected(season_id, season_code, display_name, start_year, end_year)
    LEFT JOIN fpl.seasons actual USING (season_id)
    WHERE actual.season_id IS NULL
       OR actual.season_code IS DISTINCT FROM expected.season_code
       OR actual.display_name IS DISTINCT FROM expected.display_name
       OR actual.start_year IS DISTINCT FROM expected.start_year
       OR actual.end_year IS DISTINCT FROM expected.end_year
  ) THEN
    RAISE EXCEPTION 'FPL entry-history reference season catalog is inconsistent';
  END IF;
END
$$;
