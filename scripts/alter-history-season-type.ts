import * as dotenv from 'dotenv';
import { getDbClient } from '../src/db/singleton';

dotenv.config();

async function main() {
  try {
    const client = await getDbClient();
    console.log('Altering entry_history_infos.season to char(7)...');
    await client.unsafe('ALTER TABLE entry_history_infos ALTER COLUMN season TYPE char(7);');
    console.log('✅ Altered season column to char(7).');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to alter season column:', err);
    process.exit(1);
  }
}

main();
