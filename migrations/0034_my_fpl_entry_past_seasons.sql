-- My FPL history is scoped by both the entry's owning season and the source
-- season represented by each FPL history row.  The legacy table only keyed
-- source season + entry id, which makes a reused FPL entry id ambiguous.
ALTER TABLE competition.entries
  ADD COLUMN IF NOT EXISTS past_seasons_checked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS past_seasons_count integer;

ALTER TABLE competition.entries
  ADD CONSTRAINT entries_past_seasons_count_nonnegative
  CHECK ((past_seasons_count IS NULL) OR (past_seasons_count >= 0));

CREATE TABLE competition.entry_past_seasons (
    entry_season_id smallint NOT NULL,
    entry_id integer NOT NULL,
    source_season_id smallint NOT NULL,
    source_season_label text NOT NULL,
    total_points integer DEFAULT 0 NOT NULL,
    overall_rank integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entry_past_seasons_ids_positive
      CHECK ((entry_id > 0) AND (source_season_id > 0)),
    CONSTRAINT entry_past_seasons_totals_nonnegative
      CHECK ((total_points >= 0) AND (overall_rank >= 0)),
    CONSTRAINT entry_past_seasons_label_format
      CHECK (source_season_label ~ '^[0-9]{4}/[0-9]{2}$'::text),
    CONSTRAINT entry_past_seasons_pkey
      PRIMARY KEY (entry_season_id, entry_id, source_season_id),
    CONSTRAINT entry_past_seasons_entry_fk
      FOREIGN KEY (entry_season_id, entry_id)
      REFERENCES competition.entries(season_id, entry_id),
    CONSTRAINT entry_past_seasons_entry_season_fk
      FOREIGN KEY (entry_season_id)
      REFERENCES fpl.seasons(season_id),
    CONSTRAINT entry_past_seasons_source_season_fk
      FOREIGN KEY (source_season_id)
      REFERENCES fpl.seasons(season_id)
);

CREATE INDEX entry_past_seasons_entry_idx
  ON competition.entry_past_seasons (entry_season_id, entry_id, source_season_id DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.entry_past_seasons TO letletme_data_writer;
GRANT SELECT
  ON TABLE competition.entry_past_seasons TO letletme_graphql_reader;

COMMENT ON TABLE competition.entry_past_seasons IS
  'Complete FPL entry history rows, scoped by owning entry season and source season.';
COMMENT ON COLUMN competition.entries.past_seasons_checked_at IS
  'Timestamp at which the complete FPL history response was validated and persisted.';
COMMENT ON COLUMN competition.entries.past_seasons_count IS
  'Number of validated past-season rows in entry_past_seasons; NULL means not checked.';
