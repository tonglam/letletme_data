import { sql } from 'drizzle-orm';
import { getDb } from './src/db/singleton';

async function populateTestData() {
  try {
    const db = await getDb();

    console.log('Populating test data for player_values...');

    // Get some existing players and events to reference
    const players = await db.execute(
      sql`SELECT id, web_name, element_type, team_id FROM players LIMIT 10`,
    );
    const events = await db.execute(sql`SELECT id FROM events WHERE finished = true LIMIT 5`);
    const teams = await db.execute(sql`SELECT id, name, short_name FROM teams LIMIT 5`);

    if (players.length === 0 || events.length === 0 || teams.length === 0) {
      console.log('❌ No existing players, events, or teams found. Please sync basic data first.');
      process.exit(1);
    }

    console.log(`Found ${players.length} players, ${events.length} events, ${teams.length} teams`);

    // Create test data for each event-player combination
    const testData = [];
    const changeTypes = ['increase', 'decrease', 'stable', 'unknown'];
    const positionNames = ['GKP', 'DEF', 'MID', 'FWD'];

    for (const event of events) {
      for (let i = 0; i < Math.min(players.length, 5); i++) {
        const player = players[i];
        const team = teams[i % teams.length];
        const changeType = changeTypes[i % changeTypes.length];
        const baseValue = 50 + i * 10;
        const lastValue =
          baseValue + (changeType === 'increase' ? -5 : changeType === 'decrease' ? 5 : 0);

        testData.push({
          event_id: event.id,
          element_id: player.id,
          web_name: player.web_name,
          element_type: player.element_type,
          element_type_name: positionNames[player.element_type - 1] || 'MID',
          team_id: team.id,
          team_name: team.name,
          team_short_name: team.short_name,
          value: baseValue,
          last_value: lastValue,
          change_date: new Date().toISOString(),
          change_type: changeType,
        });
      }
    }

    console.log(`Inserting ${testData.length} test records...`);

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
        ON CONFLICT (event_id, element_id) 
        DO UPDATE SET
          web_name = excluded.web_name,
          element_type_name = excluded.element_type_name,
          team_id = excluded.team_id,
          team_name = excluded.team_name,
          team_short_name = excluded.team_short_name,
          value = excluded.value,
          last_value = excluded.last_value,
          change_date = excluded.change_date,
          change_type = excluded.change_type
      `);
    }

    // Check final count
    const countResult = await db.execute(sql`SELECT COUNT(*) as count FROM player_values`);
    const count = countResult[0]?.count || 0;

    console.log(`✅ Successfully populated ${count} player values records!`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error populating test data:', error);
    process.exit(1);
  }
}

populateTestData();
