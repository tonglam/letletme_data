-- Tournament 3 was created before eligible official Classic leagues defaulted
-- to authoritative roster synchronization. Move only this fully identified
-- active tournament into pending official-sync mode. Membership remains
-- untouched here: the existing roster worker keeps it frozen during an active
-- gameweek and reconciles it from FPL only after the next data-checked boundary.
UPDATE competition.tournaments AS tournament
SET roster_mode = 'official_sync',
    roster_sync_status = 'pending',
    roster_sync_error = NULL,
    roster_last_synced_at = NULL,
    updated_at = now()
WHERE tournament.season_id = 2026
  AND tournament.tournament_id = 3
  AND tournament.league_id = 8863
  AND tournament.league_type = 'classic'
  AND tournament.group_mode = 'points_races'
  AND tournament.group_num = 1
  AND tournament.knockout_mode = 'no_knockout'
  AND tournament.state = 'active'
  AND tournament.setup_status = 'ready'
  AND tournament.roster_mode = 'snapshot'
  AND tournament.total_team_num > 0
  AND tournament.total_team_num = (
    SELECT count(*)::integer
    FROM competition.tournament_entries AS entry
    WHERE entry.season_id = tournament.season_id
      AND entry.tournament_id = tournament.tournament_id
  )
  AND tournament.total_team_num <= (
    SELECT count(*)::integer
    FROM competition.entry_leagues AS league
    WHERE league.season_id = tournament.season_id
      AND league.league_id = tournament.league_id
      AND league.league_type = tournament.league_type
  );
