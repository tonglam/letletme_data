import { sql } from 'drizzle-orm';
import { databaseSingleton, getDb } from '../src/db/singleton';

async function main() {
  const db = await getDb();
  try {
    console.log('Making defensive_contribution NOT NULL...');

    // Update existing NULL values to 0 first
    const updateResult = await db.execute(
      sql`UPDATE event_lives SET defensive_contribution = 0 WHERE defensive_contribution IS NULL`,
    );
    console.log(`✓ Updated ${updateResult.rowCount ?? 0} NULL values to 0`);

    // Set default value
    await db.execute(
      sql`ALTER TABLE event_lives ALTER COLUMN defensive_contribution SET DEFAULT 0`,
    );
    console.log('✓ Set default value to 0');

    // Make it NOT NULL
    await db.execute(sql`ALTER TABLE event_lives ALTER COLUMN defensive_contribution SET NOT NULL`);
    console.log('✓ Made column NOT NULL');

    // Update comment
    await db.execute(
      sql`COMMENT ON COLUMN event_lives.defensive_contribution IS 'Defensive contribution metric for the player in this event (default: 0)'`,
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
