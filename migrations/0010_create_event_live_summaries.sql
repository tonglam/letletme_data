CREATE TABLE IF NOT EXISTS event_live_summaries (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  event_id integer NOT NULL REFERENCES events(id),
  element_id integer NOT NULL REFERENCES players(id),
  element_type integer NOT NULL,
  team_id integer NOT NULL REFERENCES teams(id),
  minutes integer NOT NULL DEFAULT 0,
  goals_scored integer NOT NULL DEFAULT 0,
  assists integer NOT NULL DEFAULT 0,
  clean_sheets integer NOT NULL DEFAULT 0,
  goals_conceded integer NOT NULL DEFAULT 0,
  own_goals integer NOT NULL DEFAULT 0,
  penalties_saved integer NOT NULL DEFAULT 0,
  penalties_missed integer NOT NULL DEFAULT 0,
  yellow_cards integer NOT NULL DEFAULT 0,
  red_cards integer NOT NULL DEFAULT 0,
  saves integer NOT NULL DEFAULT 0,
  bonus integer NOT NULL DEFAULT 0,
  bps integer NOT NULL DEFAULT 0,
  total_points integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_event_live_summary_element
  ON event_live_summaries (element_id);

CREATE INDEX IF NOT EXISTS idx_event_live_summary_event_id
  ON event_live_summaries (event_id);
