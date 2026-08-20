-- Add the FPL season totals needed by the player season timeline.
--
-- The Player State projection already has a transactional, advisory-locked
-- refresh function.  Keep that function as the canonical projection builder
-- and wrap it so these raw summary values are copied in the same transaction
-- and the projection hash changes whenever one of them changes.
ALTER TABLE reporting.player_state_season_rows
  ADD COLUMN fpl_total_points integer NOT NULL DEFAULT 0,
  ADD COLUMN fpl_starts integer NOT NULL DEFAULT 0,
  ADD COLUMN fpl_clean_sheets integer NOT NULL DEFAULT 0,
  ADD COLUMN fpl_saves integer NOT NULL DEFAULT 0;

ALTER TABLE reporting.player_state_season_rows
  ADD CONSTRAINT player_state_season_rows_fpl_summary_counts_nonnegative
  CHECK (
    fpl_starts >= 0
    AND fpl_clean_sheets >= 0
    AND fpl_saves >= 0
  );

ALTER FUNCTION reporting.refresh_player_state_season(smallint)
  RENAME TO refresh_player_state_season_base;

CREATE OR REPLACE FUNCTION reporting.refresh_player_state_season(
  requested_season_id smallint
)
RETURNS TABLE (
  revision bigint,
  player_count integer,
  understat_player_count integer,
  source_updated_at timestamptz,
  refreshed_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, reporting, fpl, understat, bridge
AS $$
DECLARE
  base_revision bigint;
  base_player_count integer;
  base_understat_player_count integer;
  base_source_updated_at timestamptz;
  base_refreshed_at timestamptz;
  updated_players integer;
BEGIN
  SELECT
    result.revision,
    result.player_count,
    result.understat_player_count,
    result.source_updated_at,
    result.refreshed_at
  INTO
    base_revision,
    base_player_count,
    base_understat_player_count,
    base_source_updated_at,
    base_refreshed_at
  FROM reporting.refresh_player_state_season_base(requested_season_id) result;

  UPDATE reporting.player_state_season_rows row
  SET
    fpl_total_points = summary.total_points,
    fpl_starts = summary.gameweeks_started,
    fpl_clean_sheets = summary.clean_sheets,
    fpl_saves = summary.saves,
    fpl_source_hash = md5(concat_ws(
      '|',
      player.updated_at::text,
      summary.source_updated_at::text,
      COALESCE(summary.minutes, 0)::text,
      summary.total_points::text,
      COALESCE(summary.bonus, 0)::text,
      COALESCE(summary.return_count, 0)::text,
      summary.gameweeks_started::text,
      summary.clean_sheets::text,
      summary.saves::text
    )),
    refreshed_at = base_refreshed_at
  FROM reporting.player_season_summary_rows summary
  JOIN fpl.players player
    ON player.season_id = summary.season_id
   AND player.element_id = summary.element_id
  WHERE row.season_id = requested_season_id
    AND summary.season_id = row.season_id
    AND summary.element_id = row.element_id;

  GET DIAGNOSTICS updated_players = ROW_COUNT;
  IF updated_players <> base_player_count THEN
    RAISE EXCEPTION
      'Cannot publish Player State season % with incomplete FPL summary projection rows',
      requested_season_id;
  END IF;

  RETURN QUERY SELECT
    base_revision,
    base_player_count,
    base_understat_player_count,
    base_source_updated_at,
    base_refreshed_at;
END;
$$;

ALTER FUNCTION reporting.refresh_player_state_season_base(smallint)
  OWNER TO letletme_data_owner;
ALTER FUNCTION reporting.refresh_player_state_season(smallint)
  OWNER TO letletme_data_owner;

REVOKE EXECUTE ON FUNCTION reporting.refresh_player_state_season_base(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.refresh_player_state_season_base(smallint) TO letletme_data_writer;
REVOKE EXECUTE ON FUNCTION reporting.refresh_player_state_season(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.refresh_player_state_season(smallint) TO letletme_data_writer;

DO $$
DECLARE
  season_row record;
BEGIN
  FOR season_row IN SELECT season_id FROM fpl.seasons ORDER BY season_id LOOP
    PERFORM reporting.refresh_player_state_season(season_row.season_id);
  END LOOP;
END;
$$;
