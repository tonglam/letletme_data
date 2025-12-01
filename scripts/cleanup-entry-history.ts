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
    if (entryId) {
      console.log(`Deleting non-season_name rows for entry_id=${entryId}...`);
      await client.unsafe(
        `DELETE FROM entry_history_infos WHERE entry_id = ${entryId} AND season NOT LIKE '____/__';`,
      );
    } else {
      console.log('Deleting all non-season_name rows globally...');
      await client.unsafe(`DELETE FROM entry_history_infos WHERE season NOT LIKE '____/__';`);
    }
    console.log('✅ Cleanup complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Cleanup failed:', err);
    process.exit(1);
  }
}

main();
