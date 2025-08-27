import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function checkTableStructure() {
  try {
    const db = await getDb();

    console.log('Checking player_values table structure...');

    const result = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'player_values' 
      ORDER BY ordinal_position
    `);

    console.log('Current columns in player_values table:');
    result.forEach((row) => {
      console.log(`- ${row.column_name}: ${row.data_type} (nullable: ${row.is_nullable})`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Error checking table:', error);
    process.exit(1);
  }
}

checkTableStructure();
