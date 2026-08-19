-- Persist FPL's official league category (s/x/c) and short_name so GraphQL can
-- match the official My Leagues grouping. competition.league_type stays classic/h2h.

CREATE TYPE competition.official_league_kind AS ENUM (
    's',
    'x',
    'c'
);

ALTER TYPE competition.official_league_kind OWNER TO letletme_data_owner;

ALTER TABLE competition.entry_leagues
    ADD COLUMN official_kind competition.official_league_kind,
    ADD COLUMN short_name text;

ALTER TABLE competition.entry_leagues
    ADD CONSTRAINT entry_leagues_short_name_nonempty
    CHECK ((short_name IS NULL) OR (btrim(short_name) <> ''::text));

COMMENT ON COLUMN competition.entry_leagues.official_kind IS
    'FPL league_type: s=system, x=invitational, c=public. Distinct from scoring league_type (classic/h2h).';

COMMENT ON COLUMN competition.entry_leagues.short_name IS
    'FPL short_name when present (overall, region-*, team-*, event-*, brd-*, …). Invitational leagues are typically null.';
