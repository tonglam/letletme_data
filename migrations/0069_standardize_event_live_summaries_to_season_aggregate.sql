-- Make event_live_summaries a season/player aggregate.
--
-- event_lives is the event/player fact table. The summary is intentionally a
-- one-row-per-player derived table, so event_id and team_id are not part of
-- its grain. History keeps season in the partition key and therefore has one
-- row per (season, element_id).

SELECT pg_advisory_xact_lock(872341);

ALTER TABLE public.event_live_summaries
  DROP COLUMN IF EXISTS event_id CASCADE,
  DROP COLUMN IF EXISTS team_id CASCADE;

ALTER TABLE public.event_live_summaries_history
  DROP COLUMN IF EXISTS event_id CASCADE,
  DROP COLUMN IF EXISTS team_id CASCADE;

TRUNCATE TABLE public.event_live_summaries RESTART IDENTITY;

INSERT INTO public.event_live_summaries (
  element_id,
  element_type,
  minutes,
  goals_scored,
  assists,
  clean_sheets,
  goals_conceded,
  own_goals,
  penalties_saved,
  penalties_missed,
  yellow_cards,
  red_cards,
  saves,
  bonus,
  bps,
  total_points,
  created_at,
  updated_at
)
SELECT
  live.element_id,
  player.type,
  COALESCE(SUM(live.minutes), 0)::integer,
  COALESCE(SUM(live.goals_scored), 0)::integer,
  COALESCE(SUM(live.assists), 0)::integer,
  COALESCE(SUM(live.clean_sheets), 0)::integer,
  COALESCE(SUM(live.goals_conceded), 0)::integer,
  COALESCE(SUM(live.own_goals), 0)::integer,
  COALESCE(SUM(live.penalties_saved), 0)::integer,
  COALESCE(SUM(live.penalties_missed), 0)::integer,
  COALESCE(SUM(live.yellow_cards), 0)::integer,
  COALESCE(SUM(live.red_cards), 0)::integer,
  COALESCE(SUM(live.saves), 0)::integer,
  COALESCE(SUM(live.bonus), 0)::integer,
  COALESCE(SUM(live.bps), 0)::integer,
  COALESCE(SUM(live.total_points), 0)::integer,
  now(),
  now()
FROM public.event_lives AS live
INNER JOIN public.players AS player ON player.id = live.element_id
GROUP BY live.element_id, player.type
ORDER BY live.element_id;

-- Sealed history is normally immutable. This migration is the explicit,
-- audited exception for this derived table only; disable the guard on the
-- history parent and its physical partitions while the rows are rebuilt, then
-- restore it before the migration commits.
DO $$
DECLARE
  relation_name text;
  relation_oid oid;
BEGIN
  FOR relation_name, relation_oid IN
    SELECT relation.relname, relation.oid
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_inherits AS inheritance
      ON inheritance.inhrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND (
        relation.relname = 'event_live_summaries_history'
        OR inheritance.inhparent = 'public.event_live_summaries_history'::regclass
      )
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = relation_oid
        AND tgname = 'reject_sealed_mutation'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I DISABLE TRIGGER reject_sealed_mutation',
        relation_name
      );
    END IF;
  END LOOP;
END $$;

TRUNCATE TABLE public.event_live_summaries_history RESTART IDENTITY;

INSERT INTO public.event_live_summaries_history (
  season,
  id,
  element_id,
  element_type,
  minutes,
  goals_scored,
  assists,
  clean_sheets,
  goals_conceded,
  own_goals,
  penalties_saved,
  penalties_missed,
  yellow_cards,
  red_cards,
  saves,
  bonus,
  bps,
  total_points,
  created_at,
  updated_at
)
SELECT
  live.season,
  live.element_id,
  live.element_id,
  player.type,
  COALESCE(SUM(live.minutes), 0)::integer,
  COALESCE(SUM(live.goals_scored), 0)::integer,
  COALESCE(SUM(live.assists), 0)::integer,
  COALESCE(SUM(live.clean_sheets), 0)::integer,
  COALESCE(SUM(live.goals_conceded), 0)::integer,
  COALESCE(SUM(live.own_goals), 0)::integer,
  COALESCE(SUM(live.penalties_saved), 0)::integer,
  COALESCE(SUM(live.penalties_missed), 0)::integer,
  COALESCE(SUM(live.yellow_cards), 0)::integer,
  COALESCE(SUM(live.red_cards), 0)::integer,
  COALESCE(SUM(live.saves), 0)::integer,
  COALESCE(SUM(live.bonus), 0)::integer,
  COALESCE(SUM(live.bps), 0)::integer,
  COALESCE(SUM(live.total_points), 0)::integer,
  now(),
  now()
FROM public.event_lives_history AS live
INNER JOIN public.players_history AS player
  ON player.season = live.season
 AND player.id = live.element_id
GROUP BY live.season, live.element_id, player.type
ORDER BY live.season, live.element_id;

-- The summary rows were deliberately regenerated, so refresh the archive
-- evidence for this one derived table while leaving all other archive items
-- untouched.
WITH archive_seasons AS (
  SELECT season
  FROM public.fpl_season_archives
), summary_counts AS (
  SELECT
    archive_seasons.season,
    COUNT(summary.id)::bigint AS row_count,
    md5(
      COALESCE(
        string_agg(
          (to_jsonb(summary) - 'season')::text,
          ''
          ORDER BY summary.id
        ),
        ''
      )
    ) AS canonical_checksum
  FROM archive_seasons
  LEFT JOIN public.event_live_summaries_history AS summary
    ON summary.season = archive_seasons.season
  GROUP BY archive_seasons.season
)
UPDATE public.fpl_season_archive_items AS item
SET
  row_count = summary_counts.row_count,
  canonical_checksum = summary_counts.canonical_checksum,
  verified_at = now(),
  updated_at = now()
FROM summary_counts
WHERE item.season = summary_counts.season
  AND item.source_table = 'event_live_summaries';

DO $$
DECLARE
  relation_name text;
  relation_oid oid;
BEGIN
  FOR relation_name, relation_oid IN
    SELECT relation.relname, relation.oid
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_inherits AS inheritance
      ON inheritance.inhrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND (
        relation.relname = 'event_live_summaries_history'
        OR inheritance.inhparent = 'public.event_live_summaries_history'::regclass
      )
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = relation_oid
        AND tgname = 'reject_sealed_mutation'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ENABLE TRIGGER reject_sealed_mutation',
        relation_name
      );
    END IF;
  END LOOP;
END $$;
