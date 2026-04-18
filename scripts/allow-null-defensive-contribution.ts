import { sql } from 'drizzle-orm';
import { databaseSingleton, getDb } from '../src/db/singleton';

async function main() {
  const db = await getDb();
  try {
    console.log('Allowing NULL values for defensive_contribution...');

    // Remove NOT NULL constraint
    await db.execute(
      sql`ALTER TABLE event_lives ALTER COLUMN defensive_contribution DROP NOT NULL`,
    );
    console.log('✓ Removed NOT NULL constraint');

    // Remove default value (optional, but cleaner)
    await db.execute(
      sql`ALTER TABLE event_lives ALTER COLUMN defensive_contribution DROP DEFAULT`,
    );
    console.log('✓ Removed default value');

    // Update comment
    await db.execute(
      sql`COMMENT ON COLUMN event_lives.defensive_contribution IS 'Defensive contribution metric for the player in this event'`,
    );
    console.log('✓ Updated column comment');

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
