import * as dotenv from 'dotenv';
import { getDbClient } from '../src/db/singleton';

dotenv.config();

async function main() {
  try {
    const client = await getDbClient();
    console.log('Truncating entry_infos with CASCADE...');
    await client.unsafe('TRUNCATE TABLE entry_infos CASCADE;');
    console.log('✅ entry_infos truncated.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to truncate entry_infos:', err);
    process.exit(1);
  }
}

main();
