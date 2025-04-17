// Load environment variables first
import 'dotenv/config';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDB, disconnectDB, prisma } from '../../../src/infrastructures/db/prisma';

// Interface for the query result
interface TestResult {
  test: number;
}

interface ValueResult1 {
  value1: number;
}

interface ValueResult2 {
  value2: number;
}

interface TransactionResult {
  query1: ValueResult1[];
  query2: ValueResult2[];
}

interface TableNameResult {
  table_name: string;
}

// This test uses the actual database connection from .env
describe('Prisma DB Connection - Integration Test', () => {
  beforeAll(async () => {
    // Connect to the database before running tests
    await pipe(
      connectDB(),
      TE.getOrElse((error) => {
        console.error('Failed to connect to database:', error);
        throw error;
      }),
    )();
  });

  afterAll(async () => {
    // Disconnect from the database after tests
    await pipe(
      disconnectDB(),
      TE.getOrElse((error) => {
        console.error('Failed to disconnect from database:', error);
        throw error;
      }),
    )();
  });

  it('should be connected to the database', () => {
    expect(prisma).toBeDefined();
  });

  it('should query the database', async () => {
    // Perform a simple query to verify connection
    // This should succeed even on an empty database
    const result = await prisma.$queryRaw<TestResult[]>`SELECT 1 as test`;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty('test', 1);
  });

  it('should be able to execute a transaction', async () => {
    // Use a transaction to verify the connection is working properly
    const result = await prisma.$transaction<TransactionResult>(async (tx) => {
      const query1 = await tx.$queryRaw<ValueResult1[]>`SELECT 1 as value1`;
      const query2 = await tx.$queryRaw<ValueResult2[]>`SELECT 2 as value2`;
      return { query1, query2 };
    });

    expect(result.query1[0]).toHaveProperty('value1', 1);
    expect(result.query2[0]).toHaveProperty('value2', 2);
  });

  it('should check if specific tables exist', async () => {
    // Query to check if a table exists in the database
    // This is useful to validate the schema is deployed
    const tables = await prisma.$queryRaw<TableNameResult[]>`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;

    // Convert the result to an array of table names
    const tableNames = tables.map((t) => t.table_name.toLowerCase());

    // Check for specific essential tables based on the actual schema
    expect(tableNames).toContain('players');
    expect(tableNames).toContain('teams');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('player_values');
    expect(tableNames).toContain('player_stats');
    expect(tableNames).toContain('phases');
  });
});
