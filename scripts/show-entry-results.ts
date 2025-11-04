import * as dotenv from 'dotenv';
import { getDbClient } from '../src/db/singleton';

dotenv.config();

async function main() {
  const [entryArg, eventArg] = process.argv.slice(2);
  const entryId = entryArg ? Number(entryArg) : undefined;
  const eventId = eventArg ? Number(eventArg) : undefined;
  try {
    const client = await getDbClient();
    let rows;
    if (entryId && eventId) {
      rows = await client`
        SELECT id, entry_id, event_id, event_points, event_transfers, event_transfers_cost,
               event_net_points, event_bench_points, event_rank, event_chip, event_played_captain,
               event_captain_points, overall_points, overall_rank, team_value, bank, created_at, updated_at
        FROM entry_event_results
        WHERE entry_id = ${entryId} AND event_id = ${eventId}
      `;
    } else if (entryId) {
      rows = await client`
        SELECT id, entry_id, event_id, event_points, event_transfers, event_transfers_cost,
               event_net_points, event_bench_points, event_rank, event_chip, event_played_captain,
               event_captain_points, overall_points, overall_rank, team_value, bank, created_at, updated_at
        FROM entry_event_results
        WHERE entry_id = ${entryId}
        ORDER BY event_id DESC
        LIMIT 5
      `;
    } else {
      rows = await client`
        SELECT id, entry_id, event_id, event_points, event_transfers, event_transfers_cost,
               event_net_points, event_bench_points, event_rank, event_chip, event_played_captain,
               event_captain_points, overall_points, overall_rank, team_value, bank, created_at, updated_at
        FROM entry_event_results
        ORDER BY created_at DESC
        LIMIT 10
      `;
    }
    console.log('entry_event_results rows:', JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Failed to query entry_event_results:', err);
    process.exit(1);
  }
}

main();

