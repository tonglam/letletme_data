-- Repair the historical team dimension after the cross-source audit.
--
-- 2016/17 and 2017/18 were loaded from transformed sources that preserved the
-- FPL team code/pulse_id but did not contain team names.  The old rows were
-- therefore created as Team 1..20 placeholders.  2026/27 already exists in
-- the current unsuffixed teams table; seed the season partition with that
-- dimension while leaving the rest of the 2026/27 archive explicitly building.

BEGIN;

UPDATE public.fpl_season_archives
SET status = 'building',
    completed_at = NULL,
    error_summary = NULL,
    updated_at = now()
WHERE season IN ('1617', '1718');

UPDATE public.team_1617 AS team
SET name = mapping.name,
    short_name = mapping.short_name,
    updated_at = now()
FROM (
  VALUES
    (3, 'Arsenal', 'ARS'),
    (91, 'Bournemouth', 'BOU'),
    (90, 'Burnley', 'BUR'),
    (8, 'Chelsea', 'CHE'),
    (31, 'Crystal Palace', 'CRY'),
    (11, 'Everton', 'EVE'),
    (88, 'Hull City', 'HUL'),
    (13, 'Leicester', 'LEI'),
    (14, 'Liverpool', 'LIV'),
    (43, 'Man City', 'MCI'),
    (1, 'Man Utd', 'MUN'),
    (25, 'Middlesbrough', 'MID'),
    (20, 'Southampton', 'SOU'),
    (110, 'Stoke City', 'STK'),
    (56, 'Sunderland', 'SUN'),
    (80, 'Swansea', 'SWA'),
    (6, 'Spurs', 'TOT'),
    (57, 'Watford', 'WAT'),
    (35, 'West Brom', 'WBA'),
    (21, 'West Ham', 'WHU')
) AS mapping(code, name, short_name)
WHERE team.code = mapping.code;

UPDATE public.team_1718 AS team
SET name = mapping.name,
    short_name = mapping.short_name,
    updated_at = now()
FROM (
  VALUES
    (3, 'Arsenal', 'ARS'),
    (91, 'Bournemouth', 'BOU'),
    (36, 'Brighton', 'BHA'),
    (90, 'Burnley', 'BUR'),
    (8, 'Chelsea', 'CHE'),
    (31, 'Crystal Palace', 'CRY'),
    (11, 'Everton', 'EVE'),
    (38, 'Huddersfield', 'HUD'),
    (13, 'Leicester', 'LEI'),
    (14, 'Liverpool', 'LIV'),
    (43, 'Man City', 'MCI'),
    (1, 'Man Utd', 'MUN'),
    (4, 'Newcastle', 'NEW'),
    (20, 'Southampton', 'SOU'),
    (88, 'Stoke City', 'STK'),
    (80, 'Swansea', 'SWA'),
    (6, 'Spurs', 'TOT'),
    (57, 'Watford', 'WAT'),
    (35, 'West Brom', 'WBA'),
    (21, 'West Ham', 'WHU')
) AS mapping(code, name, short_name)
WHERE team.code = mapping.code;

WITH checks AS (
  SELECT
    season,
    count(*)::bigint AS row_count,
    md5(coalesce(string_agg(to_jsonb(team)::text, '' ORDER BY team.id), '')) AS checksum
  FROM public.fpl_team_history AS team
  WHERE season IN ('1617', '1718')
  GROUP BY season
)
UPDATE public.fpl_season_archive_items AS item
SET row_count = checks.row_count,
    canonical_checksum = checks.checksum,
    verified_at = now(),
    updated_at = now()
FROM checks
WHERE item.season = checks.season
  AND item.source_table = 'teams'
  AND item.archive_table = 'fpl_team_history';

UPDATE public.fpl_season_archives
SET status = 'sealed',
    reason = concat(
      reason,
      ' Historical team names repaired from preserved FPL team code/pulse_id mappings on 2026-08-08.'
    ),
    completed_at = now(),
    error_summary = NULL,
    updated_at = now()
WHERE season IN ('1617', '1718');

INSERT INTO public.fpl_season_archives (
  season,
  status,
  reason,
  source_core_revision,
  started_at,
  completed_at,
  error_summary,
  updated_at
)
VALUES (
  '2627',
  'building',
  'Current 2026/27 team dimension seeded into the historical partition. Other 2026/27 history tables remain unbackfilled.',
  'https://www.premierleague.com/en/news/4675097/all-380-fixtures-for-202627-premier-league-season; copied from public.teams',
  now(),
  NULL,
  NULL,
  now()
)
ON CONFLICT (season) DO UPDATE
SET status = 'building',
    reason = EXCLUDED.reason,
    source_core_revision = EXCLUDED.source_core_revision,
    completed_at = NULL,
    error_summary = NULL,
    updated_at = now();

INSERT INTO public.team_2627 (
  season,
  id,
  code,
  name,
  short_name,
  strength,
  position,
  points,
  win,
  draw,
  loss,
  created_at,
  played,
  form,
  team_division,
  unavailable,
  strength_overall_home,
  strength_overall_away,
  strength_attack_home,
  strength_attack_away,
  strength_defence_home,
  strength_defence_away,
  pulse_id,
  updated_at
)
SELECT
  '2627',
  id,
  code,
  name,
  short_name,
  strength,
  position,
  points,
  win,
  draw,
  loss,
  created_at,
  played,
  form,
  team_division,
  unavailable,
  strength_overall_home,
  strength_overall_away,
  strength_attack_home,
  strength_attack_away,
  strength_defence_home,
  strength_defence_away,
  pulse_id,
  updated_at
FROM public.teams
ON CONFLICT (season, id) DO UPDATE
SET code = EXCLUDED.code,
    name = EXCLUDED.name,
    short_name = EXCLUDED.short_name,
    strength = EXCLUDED.strength,
    position = EXCLUDED.position,
    points = EXCLUDED.points,
    win = EXCLUDED.win,
    draw = EXCLUDED.draw,
    loss = EXCLUDED.loss,
    created_at = EXCLUDED.created_at,
    played = EXCLUDED.played,
    form = EXCLUDED.form,
    team_division = EXCLUDED.team_division,
    unavailable = EXCLUDED.unavailable,
    strength_overall_home = EXCLUDED.strength_overall_home,
    strength_overall_away = EXCLUDED.strength_overall_away,
    strength_attack_home = EXCLUDED.strength_attack_home,
    strength_attack_away = EXCLUDED.strength_attack_away,
    strength_defence_home = EXCLUDED.strength_defence_home,
    strength_defence_away = EXCLUDED.strength_defence_away,
    pulse_id = EXCLUDED.pulse_id,
    updated_at = EXCLUDED.updated_at;

INSERT INTO public.fpl_season_archive_items (
  season,
  source_table,
  archive_table,
  row_count,
  canonical_checksum,
  verified_at,
  created_at,
  updated_at
)
SELECT
  '2627',
  'teams',
  'fpl_team_history',
  count(*)::bigint,
  md5(coalesce(string_agg(to_jsonb(team)::text, '' ORDER BY team.id), '')),
  now(),
  now(),
  now()
FROM public.team_2627 AS team
ON CONFLICT (season, source_table) DO UPDATE
SET row_count = EXCLUDED.row_count,
    canonical_checksum = EXCLUDED.canonical_checksum,
    verified_at = EXCLUDED.verified_at,
    updated_at = EXCLUDED.updated_at;

COMMIT;
