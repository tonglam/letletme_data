import { sql } from 'drizzle-orm';
import { eventLive } from '../src/db/schemas/index.schema';
import { databaseSingleton, getDb } from '../src/db/singleton';

async function main() {
  const db = await getDb();
  try {
    // Try to select the column directly - if it exists, this will work
    try {
      const testSelect = await db.execute(
        sql`SELECT defensive_contribution FROM event_lives LIMIT 1`,
      );
      console.log('✓ Column defensive_contribution exists and is accessible');
    } catch (error: unknown) {
      const err = error as Error;
      if (err.message?.includes('defensive_contribution') || err.message?.includes('column')) {
        console.log('✗ Column defensive_contribution not found:', err.message);
        return;
      }
      throw error;
    }

    // Check column details
    const result = await db.execute(
      sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'event_lives' AND column_name = 'defensive_contribution'
      `,
    );

    if (result.rows && result.rows.length > 0) {
      console.log('✓ Column details:');
      console.log('  Column:', result.rows[0].column_name);
      console.log('  Type:', result.rows[0].data_type);
      console.log('  Nullable:', result.rows[0].is_nullable);
    }

    // Check column comment
    const commentResult = await db.execute(
      sql`
        SELECT obj_description('event_lives'::regclass, 'pg_class') as table_comment,
               col_description('event_lives'::regclass::oid, 
                 (SELECT ordinal_position FROM information_schema.columns 
                  WHERE table_name = 'event_lives' AND column_name = 'defensive_contribution')) as column_comment
      `,
    );

    // Try a simpler query for the comment
    const commentQuery = await db.execute(
      sql`
        SELECT pg_catalog.col_description(
          'event_lives'::regclass::oid,
          (SELECT ordinal_position FROM information_schema.columns 
           WHERE table_name = 'event_lives' AND column_name = 'defensive_contribution')
        ) as comment
      `,
    );

    if (commentQuery.rows && commentQuery.rows[0]?.comment) {
      console.log('✓ Column comment:', commentQuery.rows[0].comment);
    }

    // Test query to ensure the column is accessible
    const testQuery = await db
      .select({
        count: sql<number>`count(*)`.as('count'),
        hasDefensiveContribution: sql<boolean>`count(defensive_contribution) > 0`.as('has_defensive_contribution'),
      })
      .from(eventLive)
      .limit(1);

    console.log('✓ Column is accessible in queries');
    console.log('  Total records:', testQuery[0]?.count ?? 0);
    console.log('  Records with defensive_contribution:', testQuery[0]?.hasDefensiveContribution ? 'Yes' : 'No');

    console.log('\n✅ Migration verification complete!');
  } catch (error) {
    console.error('✗ Verification failed:', error);
    throw error;
  } finally {
    await databaseSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
