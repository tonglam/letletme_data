import 'dotenv/config';

import { describe, expect, it } from 'bun:test';
import { db } from 'db/index';
import { sql } from 'drizzle-orm';

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

interface TableNameResult {
  table_name: string;
  [key: string]: any; // Index signature
}

describe('Drizzle DB Connection - Integration Test', () => {
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
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('phases');
    expect(tableNames).toContain('teams');
    expect(tableNames).toContain('players');
    expect(tableNames).toContain('player_values');
    expect(tableNames).toContain('player_stats');
    expect(tableNames).toContain('player_value_tracks');
    expect(tableNames).toContain('event_fixtures');
    expect(tableNames).toContain('event_live');
    expect(tableNames).toContain('event_live_explains');
    expect(tableNames).toContain('entry_infos');
    expect(tableNames).toContain('entry_history_infos');
    expect(tableNames).toContain('entry_league_infos');
    expect(tableNames).toContain('entry_event_picks');
    expect(tableNames).toContain('entry_event_results');
    expect(tableNames).toContain('entry_event_transfers');
    expect(tableNames).toContain('tournament_infos');
    expect(tableNames).toContain('tournament_entries');
    expect(tableNames).toContain('tournament_groups');
    expect(tableNames).toContain('tournament_knockouts');
    expect(tableNames).toContain('tournament_battle_group_results');
    expect(tableNames).toContain('tournament_knockout_results');
    expect(tableNames).toContain('tournament_points_group_results');
    // Add more table checks as needed based on your schema.ts
  });
});
