import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function checkTableDetails() {
  try {
    const db = await getDb();

    console.log('Checking detailed player_values table structure...');

    const result = await db.execute(sql`
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'player_values' 
      ORDER BY ordinal_position
    `);

    console.log('Columns in player_values table:');
    result.forEach((row) => {
      console.log(
        `- ${row.column_name}: ${row.data_type}${row.character_maximum_length ? `(${row.character_maximum_length})` : ''} (nullable: ${row.is_nullable})`,
      );
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Error checking table:', error);
    process.exit(1);
  }
}

checkTableDetails();
