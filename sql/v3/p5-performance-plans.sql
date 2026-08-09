\set ON_ERROR_STOP on

-- Reproducible query-plan evidence for P5. These defaults target the deterministic
-- 500 x 38 x 15 rehearsal fixture and the restored-B0 player-state subject.
\set p5_tournament_id 9500001
\set p5_event_id 1
\set p5_player_code 226597

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '10s';

SELECT element_id AS p5_summary_element_id
FROM fpl.player_gameweek_stats
WHERE season_id = 2025
GROUP BY element_id
ORDER BY count(*) DESC, element_id
LIMIT 1
\gset

\echo p5-query:tournament-selection-read
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT *
FROM reporting.tournament_selection_stats
WHERE tournament_id = :p5_tournament_id
  AND event_id = :p5_event_id
ORDER BY selected_count DESC, element_id
LIMIT 15;

\echo p5-query:player-season-summary-read
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT *
FROM reporting.player_season_summaries
WHERE season_id = 2025
  AND element_id = :p5_summary_element_id;

\echo p5-query:player-state-fpl-history
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
WITH requested AS (
  SELECT season.season_id, season.season_code, subject.element_type AS position
  FROM fpl.seasons season
  JOIN fpl.players subject
    ON subject.season_id = season.season_id
   AND subject.code = :p5_player_code
  WHERE season.lifecycle_state = 'completed'
), peers AS (
  SELECT
    requested.season_id,
    requested.season_code,
    player.element_id,
    player.code AS player_code,
    player.element_type AS position,
    player.updated_at AS player_updated_at
  FROM requested
  JOIN fpl.players player
    ON player.season_id = requested.season_id
   AND player.element_type = requested.position
), summaries AS (
  SELECT
    stats.season_id,
    stats.element_id,
    coalesce(sum(stats.minutes), 0)::integer AS minutes,
    coalesce(sum(stats.total_points), 0)::integer AS total_points,
    coalesce(sum(stats.bonus), 0)::integer AS bonus,
    count(*) FILTER (WHERE stats.total_points >= 5)::integer AS return_count,
    count(stats.event_id)::integer AS gameweek_count,
    max(stats.updated_at) AS as_of
  FROM fpl.player_gameweek_stats stats
  JOIN requested ON requested.season_id = stats.season_id
  GROUP BY stats.season_id, stats.element_id
)
SELECT
  peers.season_code AS season,
  peers.player_code,
  peers.position,
  coalesce(summaries.minutes, 0)::integer AS minutes,
  coalesce(summaries.total_points, 0)::integer AS total_points,
  coalesce(summaries.bonus, 0)::integer AS bonus,
  coalesce(summaries.return_count, 0)::integer AS return_count,
  coalesce(summaries.gameweek_count, 0)::integer AS gameweek_count,
  greatest(peers.player_updated_at, summaries.as_of) AS as_of
FROM peers
LEFT JOIN summaries
  ON summaries.season_id = peers.season_id
 AND summaries.element_id = peers.element_id
ORDER BY peers.season_code, peers.player_code;

\echo p5-query:player-state-understat-cohorts
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
WITH requested AS (
  SELECT season.season_id, season.season_code, subject.element_type AS position
  FROM fpl.seasons season
  JOIN fpl.players subject
    ON subject.season_id = season.season_id
   AND subject.code = :p5_player_code
  WHERE season.season_code = ANY(
    ARRAY['2021', '2122', '2223', '2324', '2425', '2526']::text[]
  )
), linked_peers AS (
  SELECT
    requested.season_code,
    player.code AS player_code,
    CASE
      WHEN link.left_entity_id ~ '^[0-9]+$' THEN link.left_entity_id::integer
    END AS player_id
  FROM requested
  JOIN fpl.players player
    ON player.season_id = requested.season_id
   AND player.element_type = requested.position
  JOIN bridge.entity_links link
    ON link.entity_type = 'player'
   AND link.left_provider = 'understat'
   AND link.right_provider = 'fpl'
   AND link.right_entity_id = player.code::text
   AND link.status IN ('auto_verified', 'manual_verified')
   AND link.evidence -> 'confirmedSeasons' ? requested.season_code
)
SELECT
  linked.season_code AS season,
  provider_season.state::text AS season_state,
  provider_season.last_seen_at AS season_last_seen_at,
  linked.player_code,
  metrics.player_id,
  linked.player_code = :p5_player_code AS is_subject,
  metrics.time_minutes AS minutes,
  metrics.position,
  metrics.non_penalty_xg,
  metrics.xa,
  metrics.shots,
  metrics.key_passes,
  metrics.xg_chain,
  metrics.xg_buildup,
  metrics.source_hash,
  metrics.updated_at
FROM linked_peers linked
JOIN understat.player_seasons metrics
  ON metrics.season_code = linked.season_code
 AND metrics.player_id = linked.player_id
JOIN understat.seasons provider_season
  ON provider_season.season_code = metrics.season_code
WHERE linked.player_id IS NOT NULL
ORDER BY linked.season_code, linked.player_code;

\echo p5-index-usage
SELECT
  schemaname,
  relname,
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting')
  AND (
    relname IN (
      'player_gameweek_stats',
      'player_season_summaries',
      'tournament_selection_stats',
      'player_seasons',
      'entity_links'
    )
    OR indexrelname LIKE 'tournament_selection_stats_%'
  )
ORDER BY schemaname, relname, indexrelname;

COMMIT;
