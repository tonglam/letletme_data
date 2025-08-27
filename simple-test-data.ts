import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function createSimpleTestData() {
  try {
    const db = await getDb();

    console.log('Creating simple test data for player_values...');

    // Get some existing event and team IDs
    const events = await db.execute(sql`SELECT id FROM events LIMIT 3`);
    const teams = await db.execute(sql`SELECT id, name, short_name FROM teams LIMIT 3`);

    if (events.length === 0 || teams.length === 0) {
      console.log('❌ No existing events or teams found. Please sync basic data first.');
      process.exit(1);
    }

    console.log(`Found ${events.length} events, ${teams.length} teams`);

    // Create simple test data
    const testData = [
      // Event 1 data
      {
        event_id: events[0].id,
        element_id: 1,
        web_name: 'Test Player 1',
        element_type: 1, // GKP
        element_type_name: 'GKP',
        team_id: teams[0].id,
        team_name: teams[0].name,
        team_short_name: teams[0].short_name,
        value: 50,
        last_value: 48,
        change_date: '20240101',
        change_type: 'increase',
      },
      {
        event_id: events[0].id,
        element_id: 2,
        web_name: 'Test Player 2',
        element_type: 2, // DEF
        element_type_name: 'DEF',
        team_id: teams[1].id,
        team_name: teams[1].name,
        team_short_name: teams[1].short_name,
        value: 65,
        last_value: 70,
        change_date: '20240101',
        change_type: 'decrease',
      },
      {
        event_id: events[0].id,
        element_id: 3,
        web_name: 'Test Player 3',
        element_type: 3, // MID
        element_type_name: 'MID',
        team_id: teams[2].id,
        team_name: teams[2].name,
        team_short_name: teams[2].short_name,
        value: 80,
        last_value: 80,
        change_date: '20240101',
        change_type: 'stable',
      },
    ];

    // If we have more events, add some data for them too
    if (events.length > 1) {
      testData.push({
        event_id: events[1].id,
        element_id: 1,
        web_name: 'Test Player 1',
        element_type: 1,
        element_type_name: 'GKP',
        team_id: teams[0].id,
        team_name: teams[0].name,
        team_short_name: teams[0].short_name,
        value: 52,
        last_value: 50,
        change_date: '20240102',
        change_type: 'increase',
      });
    }

    console.log(`Inserting ${testData.length} test records...`);

    // Clear existing test data first
    await db.execute(sql`DELETE FROM player_values WHERE element_id IN (1, 2, 3)`);

    // Insert test data
    for (const data of testData) {
      await db.execute(sql`
        INSERT INTO player_values (
          event_id, element_id, web_name, element_type, element_type_name,
          team_id, team_name, team_short_name, value, last_value, 
          change_date, change_type
        ) VALUES (
          ${data.event_id}, ${data.element_id}, ${data.web_name}, 
          ${data.element_type}, ${data.element_type_name},
          ${data.team_id}, ${data.team_name}, ${data.team_short_name},
          ${data.value}, ${data.last_value}, ${data.change_date}, ${data.change_type}
        )
      `);
    }

    // Check final count
    const countResult = await db.execute(sql`SELECT COUNT(*) as count FROM player_values`);
    const count = countResult[0]?.count || 0;

    console.log(`✅ Successfully created ${count} player values records!`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating test data:', error);
    process.exit(1);
  }
}

createSimpleTestData();
