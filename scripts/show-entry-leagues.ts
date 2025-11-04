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
    const rows = entryId
      ? await client`
          SELECT id, entry_id, league_id, league_name, league_type, started_event, entry_rank, entry_last_rank, created_at
          FROM entry_league_infos
          WHERE entry_id = ${entryId}
          ORDER BY league_type, league_id
        `
      : await client`
          SELECT id, entry_id, league_id, league_name, league_type, started_event, entry_rank, entry_last_rank, created_at
          FROM entry_league_infos
          ORDER BY entry_id, league_type, league_id
          LIMIT 50
        `;
    console.log('entry_league_infos rows:', JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Failed to query entry_league_infos:', err);
    process.exit(1);
  }
}

main();

