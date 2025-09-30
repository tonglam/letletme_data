import { getDbClient } from './src/db/singleton';
import { logError, logInfo } from './src/utils/logger';

async function main() {
  try {
    const client = await getDbClient();

    logInfo('=== Migrating fixtures data to event_fixtures ===');

    // Step 1: Add new columns to event_fixtures
    logInfo('Step 1: Adding new columns to event_fixtures table...');

    await client`
      ALTER TABLE event_fixtures 
      ADD COLUMN IF NOT EXISTS finished_provisional BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS provisional_start_time BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS stats JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS team_h_difficulty INTEGER,
      ADD COLUMN IF NOT EXISTS team_a_difficulty INTEGER,
      ADD COLUMN IF NOT EXISTS pulse_id INTEGER,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now()
    `;

    logInfo('✅ Columns added');

    // Step 2: Copy data from fixtures to event_fixtures
    logInfo('Step 2: Copying data from fixtures to event_fixtures...');

    await client`
      INSERT INTO event_fixtures (
        id, code, event_id, finished, finished_provisional, kickoff_time, 
        minutes, provisional_start_time, started, team_a_id, team_a_score,
        team_h_id, team_h_score, stats, team_h_difficulty, team_a_difficulty, 
        pulse_id, created_at, updated_at
      )
      SELECT 
        id, code, event, finished, finished_provisional, kickoff_time,
        minutes, provisional_start_time, started, team_a, team_a_score,
        team_h, team_h_score, stats, team_h_difficulty, team_a_difficulty,
        pulse_id, created_at, updated_at
      FROM fixtures
      ON CONFLICT (id) DO UPDATE SET
        code = EXCLUDED.code,
        event_id = EXCLUDED.event_id,
        finished = EXCLUDED.finished,
        finished_provisional = EXCLUDED.finished_provisional,
        kickoff_time = EXCLUDED.kickoff_time,
        minutes = EXCLUDED.minutes,
        provisional_start_time = EXCLUDED.provisional_start_time,
        started = EXCLUDED.started,
        team_a_id = EXCLUDED.team_a_id,
        team_a_score = EXCLUDED.team_a_score,
        team_h_id = EXCLUDED.team_h_id,
        team_h_score = EXCLUDED.team_h_score,
        stats = EXCLUDED.stats,
        team_h_difficulty = EXCLUDED.team_h_difficulty,
        team_a_difficulty = EXCLUDED.team_a_difficulty,
        pulse_id = EXCLUDED.pulse_id,
        updated_at = EXCLUDED.updated_at
    `;

    const count = await client`SELECT COUNT(*) as count FROM event_fixtures`;
    logInfo(`✅ Migrated ${count[0].count} fixtures`);

    // Step 3: Update pulse_id to be NOT NULL (after data is migrated)
    logInfo('Step 3: Setting pulse_id as NOT NULL...');
    await client`ALTER TABLE event_fixtures ALTER COLUMN pulse_id SET NOT NULL`;
    logInfo('✅ Schema updated');

    // Step 4: Drop the old fixtures table
    logInfo('Step 4: Dropping old fixtures table...');
    await client`DROP TABLE IF EXISTS fixtures CASCADE`;
    logInfo('✅ Old table dropped');

    logInfo('=== Migration Complete! ===');
    logInfo(`✅ Successfully migrated to event_fixtures table`);

    process.exit(0);
  } catch (error) {
    logError('Migration failed', error);
    console.error(error);
    process.exit(1);
  }
}

main();
