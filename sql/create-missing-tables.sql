-- Create missing tables for integration tests

-- Table: event_live_summaries
CREATE TABLE IF NOT EXISTS event_live_summaries (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    element_id INTEGER NOT NULL REFERENCES players(id),
    element_type INTEGER NOT NULL,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    minutes INTEGER DEFAULT 0 NOT NULL,
    goals_scored INTEGER DEFAULT 0 NOT NULL,
    assists INTEGER DEFAULT 0 NOT NULL,
    clean_sheets INTEGER DEFAULT 0 NOT NULL,
    goals_conceded INTEGER DEFAULT 0 NOT NULL,
    own_goals INTEGER DEFAULT 0 NOT NULL,
    penalties_saved INTEGER DEFAULT 0 NOT NULL,
    penalties_missed INTEGER DEFAULT 0 NOT NULL,
    yellow_cards INTEGER DEFAULT 0 NOT NULL,
    red_cards INTEGER DEFAULT 0 NOT NULL,
    saves INTEGER DEFAULT 0 NOT NULL,
    bonus INTEGER DEFAULT 0 NOT NULL,
    bps INTEGER DEFAULT 0 NOT NULL,
    total_points INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_event_live_summary_element ON event_live_summaries(element_id);
CREATE INDEX IF NOT EXISTS idx_event_live_summary_event_id ON event_live_summaries(event_id);

-- Success message
SELECT 'Tables created successfully!' AS message;
