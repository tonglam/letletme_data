import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import pino, { Logger } from 'pino';

// Configs
import { apiConfig } from '../../src/configs/api/api.config';
// Infrastructures
// import { redisClient } from '../../src/infrastructures/cache/client'; // redisClient managed globally
import { createHTTPClient, HTTPClient } from '../../src/infrastructures/http';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/utils';
// Add db type if needed from Drizzle
// import { NodePgDatabase } from 'drizzle-orm/node-postgres';
// import * as schema from '../../src/db/schema';
// type DbClient = NodePgDatabase<typeof schema>;

// --- Interfaces ---

// Generic setup result containing core resources
export interface IntegrationTestSetupResult {
  prisma: PrismaClient;
  // db: DbClient; // Use if switching fully to Drizzle
  logger: Logger;
  httpClient: HTTPClient;
  // Add common repositories here if they should always be created
  // Example: eventRepository: EventRepository;
}

export type TeardownIntegrationTest = (setup: IntegrationTestSetupResult) => Promise<void>;

// --- Generic Setup Function ---

export const setupIntegrationTest = async (): Promise<IntegrationTestSetupResult> => {
  const prisma = new PrismaClient();
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  const httpClient = createHTTPClient({
    client: axios.create({ baseURL: apiConfig.baseUrl }),
    logger,
    retryConfig: { ...DEFAULT_RETRY_CONFIG, attempts: 3 },
  });

  // Instantiate common repositories if desired
  // const eventRepository = createEventRepository(prisma);

  return {
    prisma,
    logger,
    httpClient,
    // eventRepository, // Include if created
  };
};

// --- Generic Teardown Function ---

export const teardownIntegrationTest: TeardownIntegrationTest = async (_setup) => {
  // Prisma client disconnects implicitly or is handled by the test runner process ending.
  // No explicit disconnect needed here generally.
  // Add any other resource cleanup needed
  // Ensure redis client is handled appropriately (e.g., closed in global teardown if needed)
  // No need to disconnect Drizzle db instance usually
};
