-- Player State season read model.
--
-- This table is deliberately downstream of FPL, Understat, and bridge data. It
-- stores the expensive cross-provider season calculations once so GraphQL can
-- read a small, player-keyed projection instead of rebuilding every cohort on
-- each request.
CREATE TABLE reporting.player_state_season_rows (
  season_id smallint NOT NULL,
  season_code text NOT NULL,
  lifecycle_state text NOT NULL,
  player_code integer NOT NULL,
  element_id integer NOT NULL,
  element_type integer NOT NULL,
  fpl_minutes integer NOT NULL DEFAULT 0,
  fpl_gameweeks integer NOT NULL DEFAULT 0,
  fpl_points_per_90 numeric,
  fpl_return_rate numeric,
  fpl_bonus_per_90 numeric,
  fpl_position_percentile numeric,
  fpl_peer_count integer NOT NULL DEFAULT 0,
  expected_metrics_available boolean NOT NULL,
  fpl_source_hash text NOT NULL,
  fpl_source_updated_at timestamptz NOT NULL,
  understat_mapping_status text NOT NULL,
  understat_player_id integer,
  understat_season_state text,
  understat_minutes integer,
  understat_npxg_per_90 numeric,
  understat_xa_per_90 numeric,
  understat_shots_per_90 numeric,
  understat_key_passes_per_90 numeric,
  understat_xg_chain_per_90 numeric,
  understat_xg_buildup_per_90 numeric,
  understat_npxg_percentile numeric,
  understat_xa_percentile numeric,
  understat_shots_percentile numeric,
  understat_key_passes_percentile numeric,
  understat_xg_chain_percentile numeric,
  understat_xg_buildup_percentile numeric,
  understat_process_percentile numeric,
  understat_peer_count integer NOT NULL DEFAULT 0,
  understat_source_hash text,
  understat_source_updated_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_state_season_rows_pkey PRIMARY KEY (season_id, player_code),
  CONSTRAINT player_state_season_rows_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons (season_id),
  CONSTRAINT player_state_season_rows_player_fk
    FOREIGN KEY (season_id, element_id)
    REFERENCES fpl.players (season_id, element_id),
  CONSTRAINT player_state_season_rows_understat_fk
    FOREIGN KEY (season_code, understat_player_id)
    REFERENCES understat.player_seasons (season_code, player_id),
  CONSTRAINT player_state_season_rows_season_code_check
    CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT player_state_season_rows_lifecycle_check
    CHECK (lifecycle_state IN ('reference_only', 'completed', 'preseason', 'active', 'closed')),
  CONSTRAINT player_state_season_rows_mapping_check
    CHECK (understat_mapping_status IN ('VERIFIED', 'UNVERIFIED', 'AMBIGUOUS', 'QUARANTINED', 'UNAVAILABLE')),
  CONSTRAINT player_state_season_rows_counts_nonnegative
    CHECK (fpl_minutes >= 0 AND fpl_gameweeks >= 0 AND fpl_peer_count >= 0 AND understat_peer_count >= 0),
  CONSTRAINT player_state_season_rows_fpl_hash_check
    CHECK (btrim(fpl_source_hash) <> ''),
  CONSTRAINT player_state_season_rows_understat_counts_check
    CHECK (understat_minutes IS NULL OR understat_minutes >= 0),
  CONSTRAINT player_state_season_rows_percentiles_check
    CHECK (
      (fpl_position_percentile IS NULL OR (fpl_position_percentile >= 0 AND fpl_position_percentile <= 100))
      AND (understat_process_percentile IS NULL OR (understat_process_percentile >= 0 AND understat_process_percentile <= 100))
    )
);

CREATE INDEX player_state_season_rows_player_idx
  ON reporting.player_state_season_rows (player_code, season_id DESC);

CREATE INDEX player_state_season_rows_season_position_idx
  ON reporting.player_state_season_rows (season_id, element_type, player_code);

CREATE TABLE reporting.player_state_season_refreshes (
  season_id smallint PRIMARY KEY,
  revision bigint NOT NULL,
  fpl_source_updated_at timestamptz NOT NULL,
  understat_source_updated_at timestamptz NOT NULL,
  bridge_source_updated_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL,
  player_count integer NOT NULL,
  understat_player_count integer NOT NULL,
  CONSTRAINT player_state_season_refreshes_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons (season_id),
  CONSTRAINT player_state_season_refreshes_revision_positive CHECK (revision > 0),
  CONSTRAINT player_state_season_refreshes_counts_nonnegative
    CHECK (player_count >= 0 AND understat_player_count >= 0)
);

CREATE TABLE reporting.player_state_dataset_metadata (
  dataset_key text PRIMARY KEY,
  revision bigint NOT NULL,
  method_version text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL,
  CONSTRAINT player_state_dataset_metadata_key_check CHECK (dataset_key = 'player_state'),
  CONSTRAINT player_state_dataset_metadata_revision_positive CHECK (revision > 0),
  CONSTRAINT player_state_dataset_metadata_method_check CHECK (btrim(method_version) <> '')
);

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
  refresh_time timestamptz;
  requested_code text;
  fpl_source_time timestamptz;
  understat_source_time timestamptz;
  bridge_source_time timestamptz;
  source_time timestamptz;
  refreshed_players integer;
  refreshed_understat_players integer;
  next_revision bigint;
BEGIN
  SELECT season.season_code
  INTO requested_code
  FROM fpl.seasons season
  WHERE season.season_id = requested_season_id;

  IF requested_code IS NULL THEN
    RAISE EXCEPTION 'Unknown FPL season id %', requested_season_id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('reporting:player-state-season:' || requested_season_id::text, 0)
  );
  refresh_time := clock_timestamp();

  SELECT GREATEST(
    COALESCE((SELECT max(player.updated_at) FROM fpl.players player WHERE player.season_id = requested_season_id), refresh_time),
    COALESCE((SELECT max(summary.source_updated_at) FROM reporting.player_season_summary_rows summary WHERE summary.season_id = requested_season_id), refresh_time)
  ) INTO fpl_source_time;

  SELECT GREATEST(
    COALESCE((SELECT max(metrics.updated_at) FROM understat.player_seasons metrics WHERE metrics.season_code = requested_code), refresh_time),
    COALESCE((SELECT max(provider_season.updated_at) FROM understat.seasons provider_season WHERE provider_season.season_code = requested_code), refresh_time)
  ) INTO understat_source_time;

  SELECT COALESCE(max(link.updated_at), refresh_time)
  INTO bridge_source_time
  FROM bridge.entity_links link
  WHERE link.entity_type = 'player'
    AND link.left_provider = 'understat'
    AND link.right_provider = 'fpl';

  source_time := GREATEST(fpl_source_time, understat_source_time, bridge_source_time);

  IF (SELECT count(*) FROM fpl.players player WHERE player.season_id = requested_season_id)
       <> (SELECT count(*) FROM reporting.player_season_summary_rows summary WHERE summary.season_id = requested_season_id)
  THEN
    RAISE EXCEPTION 'Cannot publish Player State season % with incomplete FPL summary rows', requested_code;
  END IF;

  DELETE FROM reporting.player_state_season_rows
  WHERE season_id = requested_season_id;

  WITH fpl_base AS MATERIALIZED (
    SELECT
      player.season_id,
      season.season_code,
      season.lifecycle_state,
      player.code AS player_code,
      player.element_id,
      player.element_type,
      COALESCE(summary.minutes, 0)::integer AS fpl_minutes,
      COALESCE(summary.gameweeks_available, 0)::integer AS fpl_gameweeks,
      CASE WHEN COALESCE(summary.minutes, 0) > 0
        THEN (COALESCE(summary.total_points, 0)::numeric * 90) / summary.minutes
      END AS fpl_points_per_90,
      CASE WHEN COALESCE(summary.gameweeks_available, 0) > 0
        THEN (COALESCE(summary.return_count, 0)::numeric / summary.gameweeks_available) * 100
      END AS fpl_return_rate,
      CASE WHEN COALESCE(summary.minutes, 0) > 0
        THEN (COALESCE(summary.bonus, 0)::numeric * 90) / summary.minutes
      END AS fpl_bonus_per_90,
      GREATEST(player.updated_at, COALESCE(summary.source_updated_at, player.updated_at)) AS fpl_source_updated_at,
      md5(concat_ws('|', player.updated_at::text, summary.source_updated_at::text,
        COALESCE(summary.minutes, 0)::text, COALESCE(summary.total_points, 0)::text,
        COALESCE(summary.bonus, 0)::text, COALESCE(summary.return_count, 0)::text)) AS fpl_source_hash,
      season.season_code >= '2223' AS expected_metrics_available
    FROM fpl.players player
    JOIN fpl.seasons season ON season.season_id = player.season_id
    LEFT JOIN reporting.player_season_summary_rows summary
      ON summary.season_id = player.season_id
     AND summary.element_id = player.element_id
    WHERE player.season_id = requested_season_id
  ),
  fpl_scored AS MATERIALIZED (
    SELECT
      subject.*,
      COALESCE(peer_stats.peer_count, 0)::integer AS fpl_peer_count,
      peer_stats.fpl_position_percentile
    FROM fpl_base subject
    LEFT JOIN LATERAL (
      SELECT
        count(*)::integer AS peer_count,
        round((
          COALESCE(CASE WHEN subject.fpl_points_per_90 IS NOT NULL
            AND count(*) FILTER (WHERE peer.fpl_points_per_90 IS NOT NULL) > 0
            THEN (
              count(*) FILTER (WHERE peer.fpl_points_per_90 < subject.fpl_points_per_90)
              + count(*) FILTER (WHERE peer.fpl_points_per_90 = subject.fpl_points_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.fpl_points_per_90 IS NOT NULL) * 100
          END, 0)
          + COALESCE(CASE WHEN subject.fpl_return_rate IS NOT NULL
            AND count(*) FILTER (WHERE peer.fpl_return_rate IS NOT NULL) > 0
            THEN (
              count(*) FILTER (WHERE peer.fpl_return_rate < subject.fpl_return_rate)
              + count(*) FILTER (WHERE peer.fpl_return_rate = subject.fpl_return_rate) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.fpl_return_rate IS NOT NULL) * 100
          END, 0)
          + COALESCE(CASE WHEN subject.fpl_bonus_per_90 IS NOT NULL
            AND count(*) FILTER (WHERE peer.fpl_bonus_per_90 IS NOT NULL) > 0
            THEN (
              count(*) FILTER (WHERE peer.fpl_bonus_per_90 < subject.fpl_bonus_per_90)
              + count(*) FILTER (WHERE peer.fpl_bonus_per_90 = subject.fpl_bonus_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.fpl_bonus_per_90 IS NOT NULL) * 100
          END, 0)
        ) / NULLIF(
          (CASE WHEN subject.fpl_points_per_90 IS NOT NULL
             AND count(*) FILTER (WHERE peer.fpl_points_per_90 IS NOT NULL) > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN subject.fpl_return_rate IS NOT NULL
             AND count(*) FILTER (WHERE peer.fpl_return_rate IS NOT NULL) > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN subject.fpl_bonus_per_90 IS NOT NULL
             AND count(*) FILTER (WHERE peer.fpl_bonus_per_90 IS NOT NULL) > 0 THEN 1 ELSE 0 END),
          0
        ), 1) AS fpl_position_percentile
      FROM fpl_base peer
      WHERE peer.element_type = subject.element_type
        AND peer.fpl_minutes >= 900
    ) peer_stats ON true
  ),
  link_rows AS MATERIALIZED (
    SELECT
      subject.*,
      link.status::text AS link_status,
      link.left_entity_id,
      link.evidence AS link_evidence,
      link.updated_at AS link_updated_at
    FROM fpl_scored subject
    LEFT JOIN LATERAL (
      SELECT link.status, link.left_entity_id, link.evidence, link.updated_at
      FROM bridge.entity_links link
      WHERE link.entity_type = 'player'
        AND link.left_provider = 'understat'
        AND link.right_provider = 'fpl'
        AND link.right_entity_id = subject.player_code::text
      ORDER BY CASE link.status::text
        WHEN 'auto_verified' THEN 1
        WHEN 'manual_verified' THEN 1
        WHEN 'ambiguous' THEN 2
        WHEN 'quarantined' THEN 3
        ELSE 4
      END, link.updated_at DESC, link.created_at DESC
      LIMIT 1
    ) link ON true
  ),
  mapped_rows AS MATERIALIZED (
    SELECT
      subject.*,
      CASE
        WHEN subject.link_status IS NULL THEN 'UNAVAILABLE'
        WHEN subject.link_status = 'quarantined' THEN 'QUARANTINED'
        WHEN subject.link_status = 'ambiguous' THEN 'AMBIGUOUS'
        WHEN subject.link_status IN ('auto_verified', 'manual_verified')
          AND (subject.link_evidence -> 'confirmedSeasons') ? subject.season_code
          THEN 'VERIFIED'
        ELSE 'UNVERIFIED'
      END AS understat_mapping_status
    FROM link_rows subject
  ),
  understat_base AS MATERIALIZED (
    SELECT
      subject.season_id,
      subject.season_code,
      subject.player_code,
      subject.element_type,
      subject.understat_mapping_status,
      metrics.player_id AS understat_player_id,
      provider_season.state::text AS understat_season_state,
      metrics.time_minutes AS understat_minutes,
      (metrics.non_penalty_xg * 90) / NULLIF(metrics.time_minutes, 0) AS understat_npxg_per_90,
      (metrics.xa * 90) / NULLIF(metrics.time_minutes, 0) AS understat_xa_per_90,
      (metrics.shots::numeric * 90) / NULLIF(metrics.time_minutes, 0) AS understat_shots_per_90,
      (metrics.key_passes::numeric * 90) / NULLIF(metrics.time_minutes, 0) AS understat_key_passes_per_90,
      (metrics.xg_chain * 90) / NULLIF(metrics.time_minutes, 0) AS understat_xg_chain_per_90,
      (metrics.xg_buildup * 90) / NULLIF(metrics.time_minutes, 0) AS understat_xg_buildup_per_90,
      metrics.source_hash AS understat_source_hash,
      metrics.updated_at AS understat_source_updated_at
    FROM mapped_rows subject
    JOIN understat.player_seasons metrics
      ON metrics.season_code = subject.season_code
     AND metrics.player_id = CASE
       WHEN subject.left_entity_id ~ '^[0-9]+$' THEN subject.left_entity_id::integer
     END
    JOIN understat.seasons provider_season
      ON provider_season.season_code = metrics.season_code
     AND provider_season.state::text IN ('active', 'complete')
    WHERE subject.understat_mapping_status = 'VERIFIED'
  ),
  understat_scored AS MATERIALIZED (
    SELECT
      subject.*,
      peer_stats.understat_peer_count,
      peer_stats.understat_npxg_percentile,
      peer_stats.understat_xa_percentile,
      peer_stats.understat_shots_percentile,
      peer_stats.understat_key_passes_percentile,
      peer_stats.understat_xg_chain_percentile,
      peer_stats.understat_xg_buildup_percentile
    FROM understat_base subject
    LEFT JOIN LATERAL (
      SELECT
        count(*)::integer AS understat_peer_count,
        CASE WHEN subject.understat_npxg_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_npxg_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_npxg_per_90 < subject.understat_npxg_per_90)
              + count(*) FILTER (WHERE peer.understat_npxg_per_90 = subject.understat_npxg_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_npxg_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_npxg_percentile,
        CASE WHEN subject.understat_xa_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_xa_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_xa_per_90 < subject.understat_xa_per_90)
              + count(*) FILTER (WHERE peer.understat_xa_per_90 = subject.understat_xa_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_xa_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_xa_percentile,
        CASE WHEN subject.understat_shots_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_shots_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_shots_per_90 < subject.understat_shots_per_90)
              + count(*) FILTER (WHERE peer.understat_shots_per_90 = subject.understat_shots_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_shots_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_shots_percentile,
        CASE WHEN subject.understat_key_passes_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_key_passes_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_key_passes_per_90 < subject.understat_key_passes_per_90)
              + count(*) FILTER (WHERE peer.understat_key_passes_per_90 = subject.understat_key_passes_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_key_passes_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_key_passes_percentile,
        CASE WHEN subject.understat_xg_chain_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_xg_chain_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_xg_chain_per_90 < subject.understat_xg_chain_per_90)
              + count(*) FILTER (WHERE peer.understat_xg_chain_per_90 = subject.understat_xg_chain_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_xg_chain_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_xg_chain_percentile,
        CASE WHEN subject.understat_xg_buildup_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 < subject.understat_xg_buildup_per_90)
              + count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 = subject.understat_xg_buildup_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_xg_buildup_percentile
      FROM understat_base peer
      WHERE peer.season_code = subject.season_code
        AND peer.element_type = subject.element_type
        AND peer.understat_minutes >= 450
    ) peer_stats ON true
  ),
  final_rows AS MATERIALIZED (
    SELECT
      subject.*,
      COALESCE(understat.understat_player_id, NULL) AS understat_player_id,
      understat.understat_season_state,
      understat.understat_minutes,
      understat.understat_npxg_per_90,
      understat.understat_xa_per_90,
      understat.understat_shots_per_90,
      understat.understat_key_passes_per_90,
      understat.understat_xg_chain_per_90,
      understat.understat_xg_buildup_per_90,
      understat.understat_npxg_percentile,
      understat.understat_xa_percentile,
      understat.understat_shots_percentile,
      understat.understat_key_passes_percentile,
      understat.understat_xg_chain_percentile,
      understat.understat_xg_buildup_percentile,
      understat.understat_source_hash,
      understat.understat_source_updated_at,
      understat.understat_peer_count,
      CASE
        WHEN understat.understat_player_id IS NULL THEN NULL
        ELSE round((
          COALESCE(understat.understat_npxg_percentile, 0)
          + COALESCE(understat.understat_xa_percentile, 0)
          + COALESCE(understat.understat_shots_percentile, 0)
          + COALESCE(understat.understat_key_passes_percentile, 0)
          + COALESCE(understat.understat_xg_chain_percentile, 0)
          + COALESCE(understat.understat_xg_buildup_percentile, 0)
        ) / NULLIF(
          (understat.understat_npxg_percentile IS NOT NULL)::integer
          + (understat.understat_xa_percentile IS NOT NULL)::integer
          + (understat.understat_shots_percentile IS NOT NULL)::integer
          + (understat.understat_key_passes_percentile IS NOT NULL)::integer
          + (understat.understat_xg_chain_percentile IS NOT NULL)::integer
          + (understat.understat_xg_buildup_percentile IS NOT NULL)::integer,
          0
        ), 1)
      END AS understat_process_percentile
    FROM mapped_rows subject
    LEFT JOIN understat_scored understat
      ON understat.season_code = subject.season_code
     AND understat.player_code = subject.player_code
  )
  INSERT INTO reporting.player_state_season_rows (
    season_id,
    season_code,
    lifecycle_state,
    player_code,
    element_id,
    element_type,
    fpl_minutes,
    fpl_gameweeks,
    fpl_points_per_90,
    fpl_return_rate,
    fpl_bonus_per_90,
    fpl_position_percentile,
    fpl_peer_count,
    expected_metrics_available,
    fpl_source_hash,
    fpl_source_updated_at,
    understat_mapping_status,
    understat_player_id,
    understat_season_state,
    understat_minutes,
    understat_npxg_per_90,
    understat_xa_per_90,
    understat_shots_per_90,
    understat_key_passes_per_90,
    understat_xg_chain_per_90,
    understat_xg_buildup_per_90,
    understat_npxg_percentile,
    understat_xa_percentile,
    understat_shots_percentile,
    understat_key_passes_percentile,
    understat_xg_chain_percentile,
    understat_xg_buildup_percentile,
    understat_process_percentile,
    understat_peer_count,
    understat_source_hash,
    understat_source_updated_at,
    refreshed_at
  )
  SELECT
    row.season_id,
    row.season_code,
    row.lifecycle_state,
    row.player_code,
    row.element_id,
    row.element_type,
    row.fpl_minutes,
    row.fpl_gameweeks,
    row.fpl_points_per_90,
    row.fpl_return_rate,
    row.fpl_bonus_per_90,
    row.fpl_position_percentile,
    row.fpl_peer_count,
    row.expected_metrics_available,
    row.fpl_source_hash,
    row.fpl_source_updated_at,
    row.understat_mapping_status,
    row.understat_player_id,
    row.understat_season_state,
    row.understat_minutes,
    row.understat_npxg_per_90,
    row.understat_xa_per_90,
    row.understat_shots_per_90,
    row.understat_key_passes_per_90,
    row.understat_xg_chain_per_90,
    row.understat_xg_buildup_per_90,
    row.understat_npxg_percentile,
    row.understat_xa_percentile,
    row.understat_shots_percentile,
    row.understat_key_passes_percentile,
    row.understat_xg_chain_percentile,
    row.understat_xg_buildup_percentile,
    row.understat_process_percentile,
    COALESCE(row.understat_peer_count, 0),
    row.understat_source_hash,
    row.understat_source_updated_at,
    refresh_time
  FROM final_rows row;

  GET DIAGNOSTICS refreshed_players = ROW_COUNT;

  SELECT count(*)::integer
  INTO refreshed_understat_players
  FROM reporting.player_state_season_rows row
  WHERE row.season_id = requested_season_id
    AND row.understat_player_id IS NOT NULL;

  INSERT INTO reporting.player_state_season_refreshes (
    season_id,
    revision,
    fpl_source_updated_at,
    understat_source_updated_at,
    bridge_source_updated_at,
    source_updated_at,
    refreshed_at,
    player_count,
    understat_player_count
  ) VALUES (
    requested_season_id,
    1,
    fpl_source_time,
    understat_source_time,
    bridge_source_time,
    source_time,
    refresh_time,
    refreshed_players,
    refreshed_understat_players
  )
  ON CONFLICT (season_id) DO UPDATE SET
    revision = reporting.player_state_season_refreshes.revision + 1,
    fpl_source_updated_at = EXCLUDED.fpl_source_updated_at,
    understat_source_updated_at = EXCLUDED.understat_source_updated_at,
    bridge_source_updated_at = EXCLUDED.bridge_source_updated_at,
    source_updated_at = EXCLUDED.source_updated_at,
    refreshed_at = EXCLUDED.refreshed_at,
    player_count = EXCLUDED.player_count,
    understat_player_count = EXCLUDED.understat_player_count
  RETURNING reporting.player_state_season_refreshes.revision
  INTO revision;

  INSERT INTO reporting.player_state_dataset_metadata (
    dataset_key,
    revision,
    method_version,
    source_updated_at,
    refreshed_at
  ) VALUES (
    'player_state',
    1,
    '1',
    source_time,
    refresh_time
  )
  ON CONFLICT (dataset_key) DO UPDATE SET
    revision = reporting.player_state_dataset_metadata.revision + 1,
    method_version = EXCLUDED.method_version,
    source_updated_at = GREATEST(
      reporting.player_state_dataset_metadata.source_updated_at,
      EXCLUDED.source_updated_at
    ),
    refreshed_at = GREATEST(
      reporting.player_state_dataset_metadata.refreshed_at,
      EXCLUDED.refreshed_at
    )
  RETURNING reporting.player_state_dataset_metadata.revision
  INTO next_revision;

  RETURN QUERY SELECT next_revision, refreshed_players, refreshed_understat_players, source_time, refresh_time;
END;
$$;

ALTER TABLE reporting.player_state_season_rows OWNER TO letletme_data_owner;
ALTER TABLE reporting.player_state_season_refreshes OWNER TO letletme_data_owner;
ALTER TABLE reporting.player_state_dataset_metadata OWNER TO letletme_data_owner;
ALTER FUNCTION reporting.refresh_player_state_season(smallint)
  OWNER TO letletme_data_owner;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON reporting.player_state_season_rows TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON reporting.player_state_season_refreshes TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON reporting.player_state_dataset_metadata TO letletme_data_writer;
REVOKE EXECUTE ON FUNCTION reporting.refresh_player_state_season(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.refresh_player_state_season(smallint) TO letletme_data_writer;
GRANT SELECT ON reporting.player_state_season_rows TO letletme_graphql_reader;
GRANT SELECT ON reporting.player_state_season_refreshes TO letletme_graphql_reader;
GRANT SELECT ON reporting.player_state_dataset_metadata TO letletme_graphql_reader;

DO $$
DECLARE
  season_row record;
BEGIN
  FOR season_row IN SELECT season_id FROM fpl.seasons ORDER BY season_id LOOP
    PERFORM reporting.refresh_player_state_season(season_row.season_id);
  END LOOP;
END;
$$;
