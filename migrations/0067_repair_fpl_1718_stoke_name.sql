-- Correct the historical 2017/18 Stoke City mapping.
-- FPL code 110 is Stoke City; code 88 belongs to Hull City in 2016/17.

BEGIN;

UPDATE public.fpl_season_archives
SET status = 'building',
    completed_at = NULL,
    error_summary = NULL,
    updated_at = now()
WHERE season = '1718';

UPDATE public.team_1718
SET name = 'Stoke City',
    short_name = 'STK',
    updated_at = now()
WHERE season = '1718'
  AND code = 110;

WITH checks AS (
  SELECT
    count(*)::bigint AS row_count,
    md5(coalesce(string_agg(to_jsonb(team)::text, '' ORDER BY team.id), '')) AS checksum
  FROM public.fpl_team_history AS team
  WHERE season = '1718'
)
UPDATE public.fpl_season_archive_items AS item
SET row_count = checks.row_count,
    canonical_checksum = checks.checksum,
    verified_at = now(),
    updated_at = now()
FROM checks
WHERE item.season = '1718'
  AND item.source_table = 'teams'
  AND item.archive_table = 'fpl_team_history';

UPDATE public.fpl_season_archives
SET status = 'sealed',
    reason = concat(
      reason,
      ' Corrected Stoke City mapping from FPL code 110 on 2026-08-08.'
    ),
    completed_at = now(),
    error_summary = NULL,
    updated_at = now()
WHERE season = '1718';

COMMIT;
