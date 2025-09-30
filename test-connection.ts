import { getDbClient } from './src/db/singleton';

async function main() {
  try {
    console.log(
      'Connection string from env:',
      process.env.DATABASE_URL || 'not set - using default',
    );
    console.log('Default connection: postgresql://localhost:5432/letletme_data');

    const client = await getDbClient();

    const dbResult = await client`SELECT current_database() as db, current_schema() as schema`;
    console.log('Connected to database:', dbResult[0].db);
    console.log('Current schema:', dbResult[0].schema);

    const tablesResult = await client`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename
    `;

    console.log('\nTables in public schema:');
    tablesResult.forEach((row: { tablename: string }) => console.log('  -', row.tablename));

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
