import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import pino, { Logger } from 'pino';

// Configs
import { apiConfig } from '../../src/configs/api/api.config';
// Infrastructures
import { createHTTPClient, HTTPClient } from '../../src/infrastructures/http';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/utils';

// --- Interfaces ---

// Generic setup result containing only core resources
export interface IntegrationTestSetupResult {
  prisma: PrismaClient;
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
  await prisma.$connect();

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

export const teardownIntegrationTest: TeardownIntegrationTest = async (setup) => {
  await setup.prisma.$disconnect();
  // Add any other resource cleanup needed
};
