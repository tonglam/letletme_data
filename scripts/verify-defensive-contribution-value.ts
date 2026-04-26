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

    console.log(`Syncing event ${currentEvent.id}...`);
    await syncEventLives(currentEvent.id);

    // Check a few records to verify defensive_contribution is set
    const sample = await db
      .select({
        elementId: eventLive.elementId,
        defensiveContribution: eventLive.defensiveContribution,
      })
      .from(eventLive)
      .where(sql`event_id = ${currentEvent.id}`)
      .limit(10);

    console.log('\nSample records with defensive_contribution:');
    sample.forEach((record) => {
      console.log(
        `  Element ${record.elementId}: defensive_contribution = ${record.defensiveContribution} (type: ${typeof record.defensiveContribution})`,
      );
    });

    // Verify all records have defensive_contribution set (not null)
    const nullCheck = await db.execute(
      sql`SELECT COUNT(*) as total, COUNT(defensive_contribution) as with_value FROM event_lives WHERE event_id = ${currentEvent.id}`,
    );

    console.log('\nVerification:');
    console.log(`  Total records: ${nullCheck.rows?.[0]?.total ?? 0}`);
    console.log(`  Records with defensive_contribution: ${nullCheck.rows?.[0]?.with_value ?? 0}`);

    // Check column constraints
    const columnInfo = await db.execute(
      sql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'event_lives' AND column_name = 'defensive_contribution'
      `,
    );

    if (columnInfo.rows && columnInfo.rows[0]) {
      console.log('\nColumn definition:');
      console.log(`  Type: ${columnInfo.rows[0].data_type}`);
      console.log(`  Nullable: ${columnInfo.rows[0].is_nullable}`);
      console.log(`  Default: ${columnInfo.rows[0].column_default}`);
    }

    console.log('\n✅ Verification complete!');
  } catch (error) {
    console.error('Verification failed:', error);
    throw error;
  } finally {
    await databaseSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
