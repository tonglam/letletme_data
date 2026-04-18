import { sql } from 'drizzle-orm';
import { eventLive } from '../src/db/schemas/index.schema';
import { databaseSingleton, getDb } from '../src/db/singleton';
import { syncEventLives } from '../src/services/event-lives.service';
import { getCurrentEvent } from '../src/services/events.service';

async function main() {
  const db = await getDb();
  try {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      console.log('No current event found');
      return;
    }

    console.log(`Syncing event ${currentEvent.id} to get latest defensive_contribution values...`);
    await syncEventLives(currentEvent.id);

    // Check records with non-zero defensive_contribution
    const nonZero = await db
      .select({
        elementId: eventLive.elementId,
        defensiveContribution: eventLive.defensiveContribution,
        bps: eventLive.bps,
        cleanSheets: eventLive.cleanSheets,
      })
      .from(eventLive)
      .where(sql`event_id = ${currentEvent.id} AND defensive_contribution > 0`)
      .limit(20);

    console.log(`\nFound ${nonZero.length} records with defensive_contribution > 0:`);
    nonZero.forEach((record) => {
      console.log(
        `  Element ${record.elementId}: defensive_contribution = ${record.defensiveContribution}, bps = ${record.bps}, clean_sheets = ${record.cleanSheets}`,
      );
    });

    // Statistics
    const stats = await db.execute(
      sql`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN defensive_contribution > 0 THEN 1 END) as non_zero,
          MIN(defensive_contribution) as min_val,
          MAX(defensive_contribution) as max_val,
          AVG(defensive_contribution)::numeric(10,2) as avg_val
        FROM event_lives 
        WHERE event_id = ${currentEvent.id}
      `,
    );

    if (stats.rows && stats.rows[0]) {
      console.log('\nStatistics:');
      console.log(`  Total records: ${stats.rows[0].total}`);
      console.log(`  Non-zero values: ${stats.rows[0].non_zero}`);
      console.log(`  Min: ${stats.rows[0].min_val}`);
      console.log(`  Max: ${stats.rows[0].max_val}`);
      console.log(`  Avg: ${stats.rows[0].avg_val}`);
    }

    console.log('\n✅ Check complete!');
  } catch (error) {
    console.error('Check failed:', error);
    throw error;
  } finally {
    await databaseSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
