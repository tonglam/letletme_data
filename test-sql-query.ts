import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function testSqlQuery() {
  try {
    const db = await getDb();

    console.log('Testing simple query...');

    // Test the exact query from findByEventId
    const result = await db.execute(sql`
      SELECT 
        element_id as "elementId",
        event_id as "eventId",
        web_name as "webName",
        element_type as "elementType",
        element_type_name as "elementTypeName",
        team_id as "teamId",
        team_name as "teamName",
        team_short_name as "teamShortName",
        value,
        last_value as "lastValue",
        change_date as "changeDate",
        change_type as "changeType"
      FROM player_values
      WHERE event_id = 1
      ORDER BY element_id
    `);

    console.log(`✅ Query executed successfully! Found ${result.length} records`);
    result.forEach((row) => {
      console.log(`  - Player ${row.elementId}: ${row.webName} (${row.changeType})`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ SQL Query Error:', error);
    process.exit(1);
  }
}

testSqlQuery();
