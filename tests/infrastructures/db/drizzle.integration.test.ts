// Load environment variables first
import 'dotenv/config';

import { sql } from 'drizzle-orm';
// Remove unused PostgresJsDatabase import
// import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';

import { db } from '../../../src/db';
// Remove unused schema import if not used by query builder tests later
// import * as schema from '../../../src/db/schema';

// Remove unused DrizzleDB type alias
// type DrizzleDB = PostgresJsDatabase<typeof schema>;

// Update interfaces to satisfy Record<string, unknown>
interface TestResult {
  test: number;
  [key: string]: any; // Index signature
}

interface ValueResult1 {
  value1: number;
  [key: string]: any; // Index signature
}

interface ValueResult2 {
  value2: number;
  [key: string]: any; // Index signature
}

// Remove unused TransactionResult interface
// interface TransactionResult {
//   query1: ValueResult1[];
//   query2: ValueResult2[];
// }

// Interface for table name query result
interface TableNameResult {
  table_name: string;
  [key: string]: any; // Index signature
}

// This test uses the actual database connection from .env
describe('Drizzle DB Connection - Integration Test', () => {
  // No explicit connect/disconnect needed for drizzle-orm/postgres-js by default
  // It manages connections implicitly. We can add explicit client connection/disconnection
  // if the underlying 'postgres' client ('client' in db/config.ts) needs it, but
  // typically it's not required for basic tests.

  // Example: If explicit connection management is needed
  // beforeAll(async () => {
  //   // Access the underlying client if needed, depends on config.ts export
  //   // await client.connect(); // Assuming 'client' is exported from config
  // });
  //
  // afterAll(async () => {
  //   // await client.end(); // Assuming 'client' is exported from config
  // });

  it('should have a Drizzle instance defined', () => {
    expect(db).toBeDefined();
  });

  it('should query the database using Drizzle execute', async () => {
    // Use db.execute for raw SQL queries with the sql tag helper
    const result = await db.execute<TestResult>(sql`SELECT 1 as test`);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Accessing properties directly should work now with the updated interface
    expect(result[0].test).toBe(1);
    // Or using toHaveProperty for robustness
    expect(result[0]).toHaveProperty('test', 1);
  });

  it('should be able to execute a transaction using Drizzle', async () => {
    // Use db.transaction and let TypeScript infer the 'tx' type
    const result = await db.transaction(async (tx) => {
      // Use the transaction client 'tx' for queries inside the transaction
      // Ensure interfaces used with execute satisfy the constraint
      const query1 = await tx.execute<ValueResult1>(sql`SELECT 1 as value1`);
      const query2 = await tx.execute<ValueResult2>(sql`SELECT 2 as value2`);
      // Drizzle returns RowList which is compatible with Array<T>
      // Return type is inferred, no need for TransactionResult interface here
      return { query1: query1 as ValueResult1[], query2: query2 as ValueResult2[] };
    });

    // Check the results returned from the transaction block
    expect(result.query1[0]).toHaveProperty('value1', 1);
    expect(result.query2[0]).toHaveProperty('value2', 2);
  });

  it('should check if specific tables exist using Drizzle', async () => {
    // Query information_schema using db.execute and sql tag
    // Ensure TableNameResult satisfies the constraint
    const tables = await db.execute<TableNameResult>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);

    // Convert the result to an array of table names
    const tableNames = tables.map((t: TableNameResult) => t.table_name.toLowerCase());

    // Check for specific essential tables based on the actual schema
    // These names should match your Drizzle schema definitions (src/db/schema.ts)
    expect(tableNames).toContain('players');
    expect(tableNames).toContain('teams');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('player_values');
    expect(tableNames).toContain('player_stats');
    expect(tableNames).toContain('phases');
    // Add more table checks as needed based on your schema.ts
  });
});
