import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function createPlayerValuesTable() {
  try {
    const db = await getDb();

    console.log('Creating player_values table...');

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS player_values (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        event_id integer NOT NULL,
        element_id integer NOT NULL,
        web_name text NOT NULL,
        element_type integer NOT NULL,
        element_type_name text NOT NULL,
        team_id integer NOT NULL,
        team_name text NOT NULL,
        team_short_name text NOT NULL,
        value integer NOT NULL,
        last_value integer NOT NULL,
        change_date text NOT NULL,
        change_type text NOT NULL,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now(),
        
        -- Foreign key constraints
        CONSTRAINT player_values_element_id_fk FOREIGN KEY (element_id) REFERENCES players(id),
        CONSTRAINT player_values_event_id_fk FOREIGN KEY (event_id) REFERENCES events(id),
        CONSTRAINT player_values_team_id_fk FOREIGN KEY (team_id) REFERENCES teams(id),
        
        -- Unique constraint for (event_id, element_id)
        CONSTRAINT player_values_event_element_unique UNIQUE (event_id, element_id)
      )
    `);

    console.log('✅ player_values table created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating table:', error);
    process.exit(1);
  }
}

createPlayerValuesTable();
