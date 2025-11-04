import * as dotenv from 'dotenv';
import { getDbClient } from '../src/db/singleton';

dotenv.config();

async function main() {
  const arg = process.argv[2];
  const entryId = arg ? Number(arg) : undefined;
  if (arg && !Number.isFinite(Number(arg))) {
    console.error('Invalid entryId:', arg);
    process.exit(1);
  }

  try {
    const client = await getDbClient();
    let rows;
    if (entryId) {
      rows = await client`
        SELECT id, entry_id, season, total_points, overall_rank, created_at
        FROM entry_history_infos
        WHERE entry_id = ${entryId}
        ORDER BY season
      `;
    } else {
      rows = await client`
        SELECT id, entry_id, season, total_points, overall_rank, created_at
        FROM entry_history_infos
        ORDER BY entry_id, season
        LIMIT 20
      `;
    }
    console.log('entry_history_infos rows:', JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Failed to query entry_history_infos:', err);
    process.exit(1);
  }
}

main();

