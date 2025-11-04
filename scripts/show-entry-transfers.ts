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
        SELECT id, entry_id, event_id, element_in_id, element_in_cost, element_in_points,
               element_out_id, element_out_cost, element_out_points, transfer_time, created_at
        FROM entry_event_transfers
        WHERE entry_id = ${entryId} AND event_id = ${eventId}
        ORDER BY transfer_time DESC
      `;
    } else if (entryId) {
      rows = await client`
        SELECT id, entry_id, event_id, element_in_id, element_in_cost, element_in_points,
               element_out_id, element_out_cost, element_out_points, transfer_time, created_at
        FROM entry_event_transfers
        WHERE entry_id = ${entryId}
        ORDER BY event_id DESC, transfer_time DESC
        LIMIT 10
      `;
    } else {
      rows = await client`
        SELECT id, entry_id, event_id, element_in_id, element_in_cost, element_in_points,
               element_out_id, element_out_cost, element_out_points, transfer_time, created_at
        FROM entry_event_transfers
        ORDER BY created_at DESC
        LIMIT 10
      `;
    }
    console.log('entry_event_transfers rows:', JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Failed to query entry_event_transfers:', err);
    process.exit(1);
  }
}

main();

