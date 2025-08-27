import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function fixChangeTypeColumn() {
  try {
    const db = await getDb();

    console.log('Converting change_type column from enum to text...');

    // First, drop the column
    await db.execute(sql`ALTER TABLE player_values DROP COLUMN IF EXISTS change_type`);

    // Add it back as text
    await db.execute(
      sql`ALTER TABLE player_values ADD COLUMN change_type text NOT NULL DEFAULT 'unknown'`,
    );

    console.log('✅ Successfully converted change_type column to text!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error fixing column:', error);
    process.exit(1);
  }
}

fixChangeTypeColumn();
