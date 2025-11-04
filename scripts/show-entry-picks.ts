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
        SELECT id, entry_id, event_id, chip, transfers, transfers_cost, created_at
        FROM entry_event_picks
        WHERE entry_id = ${entryId} AND event_id = ${eventId}
      `;
    } else if (entryId) {
      rows = await client`
        SELECT id, entry_id, event_id, chip, transfers, transfers_cost, created_at
        FROM entry_event_picks
        WHERE entry_id = ${entryId}
        ORDER BY event_id DESC
        LIMIT 5
      `;
    } else {
      rows = await client`
        SELECT id, entry_id, event_id, chip, transfers, transfers_cost, created_at
        FROM entry_event_picks
        ORDER BY created_at DESC
        LIMIT 10
      `;
    }
    console.log('entry_event_picks rows:', JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Failed to query entry_event_picks:', err);
    process.exit(1);
  }
}

main();

