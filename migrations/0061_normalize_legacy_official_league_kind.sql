-- The entry mapper no longer persists the historical c category. Normalize
-- rows captured before that contract so the stored snapshot is deterministic
-- regardless of when an entry was last refreshed.
UPDATE competition.entry_leagues
SET official_kind = NULL,
    updated_at = now()
WHERE official_kind = 'c'::competition.official_league_kind;

ALTER TABLE competition.entry_leagues
    ADD CONSTRAINT entry_leagues_official_kind_supported
    CHECK ((official_kind IS NULL) OR (official_kind <> 'c'::competition.official_league_kind));

COMMENT ON COLUMN competition.entry_leagues.official_kind IS
    'FPL league_type: s=system, x=invitational. Legacy c values are normalized to NULL. Distinct from scoring league_type (classic/h2h).';
