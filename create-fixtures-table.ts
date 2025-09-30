import { getDbClient } from './src/db/singleton';

async function main() {
  try {
    console.log('Creating fixtures table in Supabase...');
    const client = await getDbClient();

    await client`
      CREATE TABLE IF NOT EXISTS fixtures (
        id INTEGER PRIMARY KEY,
        code INTEGER NOT NULL,
        event INTEGER,
        finished BOOLEAN NOT NULL DEFAULT false,
        finished_provisional BOOLEAN NOT NULL DEFAULT false,
        kickoff_time TIMESTAMP,
        minutes INTEGER NOT NULL DEFAULT 0,
        provisional_start_time BOOLEAN NOT NULL DEFAULT false,
        started BOOLEAN,
        team_a INTEGER NOT NULL,
        team_a_score INTEGER,
        team_h INTEGER NOT NULL,
        team_h_score INTEGER,
        stats JSONB NOT NULL DEFAULT '[]'::jsonb,
        team_h_difficulty INTEGER,
        team_a_difficulty INTEGER,
        pulse_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now(),
        CONSTRAINT fk_fixtures_event FOREIGN KEY (event) REFERENCES events(id),
        CONSTRAINT fk_fixtures_team_a FOREIGN KEY (team_a) REFERENCES teams(id),
        CONSTRAINT fk_fixtures_team_h FOREIGN KEY (team_h) REFERENCES teams(id)
      )
    `;

    console.log('✅ Fixtures table created successfully!');

    // Verify it exists
    const result = await client`SELECT tablename FROM pg_tables WHERE tablename = 'fixtures'`;
    console.log('Verification:', result);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating table:', error);
    process.exit(1);
  }
}

main();
