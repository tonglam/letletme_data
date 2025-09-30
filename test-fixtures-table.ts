import { fixtures } from './src/db/schemas/fixtures.schema';
import { getDb } from './src/db/singleton';

async function main() {
  try {
    console.log('Testing fixtures table access...');
    const db = await getDb();

    console.log('Attempting to select from fixtures table...');
    const result = await db.select().from(fixtures).limit(1);

    console.log('✅ SUCCESS! Can access fixtures table');
    console.log('Result count:', result.length);

    process.exit(0);
  } catch (error) {
    console.error('❌ FAILED to access fixtures table:');
    console.error(error);
    process.exit(1);
  }
}

main();
