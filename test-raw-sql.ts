import { getDbClient } from './src/db/singleton';

async function main() {
  try {
    console.log('Testing raw SQL access to fixtures table...');
    const client = await getDbClient();

    console.log('Running: SELECT * FROM fixtures LIMIT 1');
    const result = await client`SELECT * FROM fixtures LIMIT 1`;

    console.log('✅ SUCCESS! Can access fixtures table with raw SQL');
    console.log('Result:', result);

    process.exit(0);
  } catch (error) {
    console.error('❌ FAILED with raw SQL:');
    console.error(error);
    process.exit(1);
  }
}

main();
