import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function checkEnums() {
  try {
    const db = await getDb();

    console.log('Checking enum types in database...');

    const result = await db.execute(sql`
      SELECT typname, enumlabel 
      FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid 
      WHERE typname = 'value_change_type'
      ORDER BY enumsortorder
    `);

    console.log('Enum values for value_change_type:');
    result.forEach((row) => {
      console.log(`- ${row.enumlabel}`);
    });

    // Also check the column type
    console.log('\nChecking player_values.change_type column:');
    const columnInfo = await db.execute(sql`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns 
      WHERE table_name = 'player_values' AND column_name = 'change_type'
    `);

    columnInfo.forEach((row) => {
      console.log(`Column: ${row.column_name}, Type: ${row.data_type}, UDT: ${row.udt_name}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Error checking enums:', error);
    process.exit(1);
  }
}

checkEnums();
