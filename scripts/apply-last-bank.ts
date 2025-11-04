import * as dotenv from 'dotenv';
import { getDbClient } from '../src/db/singleton';

dotenv.config();

async function main() {
  const sql = `ALTER TABLE entry_infos ADD COLUMN IF NOT EXISTS last_bank integer;`;
  try {
    const client = await getDbClient();
    console.log('Applying migration: add last_bank to entry_infos...');
    await client.unsafe(sql);
    console.log('✅ Applied last_bank column successfully.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to apply last_bank column:', err);
    process.exit(1);
  }
}

main();

