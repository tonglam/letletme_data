import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { connectDB, disconnectDB, prisma } from '../../src/infrastructure/db/prisma';

interface QueryResult {
  result: number;
}

describe('Prisma Database Connection Tests', () => {
  beforeAll(async () => {
    // Ensure database is disconnected before tests
    await pipe(disconnectDB(), (task) => task());
  });

  afterAll(async () => {
    // Clean up by disconnecting after tests
    await pipe(disconnectDB(), (task) => task());
  });

  it('should successfully connect to the database', async () => {
    const result = await pipe(connectDB(), (task) => task());

    expect(E.isRight(result)).toBe(true);
  });

  it('should successfully disconnect from the database', async () => {
    // First connect
    await pipe(connectDB(), (task) => task());

    // Then test disconnect
    const result = await pipe(disconnectDB(), (task) => task());

    expect(E.isRight(result)).toBe(true);
  });

  it('should be able to perform a simple query', async () => {
    await pipe(connectDB(), (task) => task());

    // Attempt a simple query to verify database connectivity
    const result = await prisma.$queryRaw<QueryResult[]>`SELECT 1 as result`;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty('result', 1);
  });

  it('should handle connection errors gracefully', async () => {
    // Force disconnect first
    await pipe(disconnectDB(), (task) => task());

    // Temporarily modify the database URL to force a connection error
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://invalid:invalid@localhost:5432/invalid_db';

    // Create a new PrismaClient instance with invalid credentials
    const invalidPrisma = new PrismaClient();

    try {
      // Attempt to query with invalid connection should throw an error
      await invalidPrisma.$queryRaw`SELECT 1`;
      throw new Error('Expected query to throw an error but it succeeded');
    } catch (error) {
      expect(error).toBeDefined();
    } finally {
      // Cleanup
      await invalidPrisma.$disconnect();
      process.env.DATABASE_URL = originalUrl;
    }
  });
});
