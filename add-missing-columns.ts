import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function addMissingColumns() {
  try {
    const db = await getDb();

    console.log('Adding missing denormalized columns to player_values table...');

    await db.execute(
      sql`ALTER TABLE player_values ADD COLUMN IF NOT EXISTS web_name text NOT NULL DEFAULT ''`,
    );
    await db.execute(
      sql`ALTER TABLE player_values ADD COLUMN IF NOT EXISTS element_type_name text NOT NULL DEFAULT ''`,
    );
    await db.execute(
      sql`ALTER TABLE player_values ADD COLUMN IF NOT EXISTS team_id integer NOT NULL DEFAULT 1`,
    );
    await db.execute(
      sql`ALTER TABLE player_values ADD COLUMN IF NOT EXISTS team_name text NOT NULL DEFAULT ''`,
    );
    await db.execute(
      sql`ALTER TABLE player_values ADD COLUMN IF NOT EXISTS team_short_name text NOT NULL DEFAULT ''`,
    );

    console.log('Adding foreign key constraint for team_id...');

    await db.execute(
      sql`ALTER TABLE player_values ADD CONSTRAINT player_values_team_id_fk FOREIGN KEY (team_id) REFERENCES teams(id)`,
    );

    console.log('✅ All missing columns added successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error adding columns:', error);
    process.exit(1);
  }
}

addMissingColumns();
