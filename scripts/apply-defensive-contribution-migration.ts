import { sql } from 'drizzle-orm';
import { databaseSingleton, getDb } from '../src/db/singleton';

async function main() {
  const db = await getDb();
  try {
    console.log('Applying defensive_contribution migration...');

    // Add defensive_contribution column
    await db.execute(
      sql`ALTER TABLE event_lives ADD COLUMN IF NOT EXISTS defensive_contribution INTEGER`,
    );
    console.log('✓ Added defensive_contribution column');

    // Add comment
    await db.execute(
      sql`COMMENT ON COLUMN event_lives.defensive_contribution IS 'Defensive contribution metric for the player in this event'`,
    );
    console.log('✓ Added column comment');

    console.log('Migration applied successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await databaseSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
