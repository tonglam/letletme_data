import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/singleton';

async function main() {
  const db = await getDb();
  try {
    console.log('Applying selected_by_percent migration...');

    // Add selected_by_percent column
    await db.execute(
      sql`ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS selected_by_percent TEXT`,
    );
    console.log('✓ Added selected_by_percent column');

    // Add comment
    await db.execute(
      sql`COMMENT ON COLUMN player_stats.selected_by_percent IS 'Percentage of FPL managers who selected this player (as string, e.g., 15.4)'`,
    );
    console.log('✓ Added column comment');

    console.log('Migration applied successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
