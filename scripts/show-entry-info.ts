import * as dotenv from 'dotenv';
import { getDbClient } from '../src/db/singleton';

dotenv.config();

async function main() {
  try {
    const client = await getDbClient();
    const rows = await client`
      SELECT 
        id,
        entry_name,
        used_entry_names,
        bank,
        last_bank,
        team_value,
        last_team_value,
        overall_points,
        last_overall_points,
        overall_rank,
        last_overall_rank,
        last_entry_name,
        created_at
      FROM entry_infos
      ORDER BY id
      LIMIT 5
    `;
    console.log('entry_infos rows:', JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Failed to query entry_infos:', err);
    process.exit(1);
  }
}

main();

