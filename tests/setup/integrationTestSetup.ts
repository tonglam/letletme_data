import { db } from 'db/index';
import pino, { type Logger } from 'pino';

type DbClient = typeof db;

export interface IntegrationTestSetupResult {
  db: DbClient;
  logger: Logger;
}

export type TeardownIntegrationTest = (setup: IntegrationTestSetupResult) => Promise<void>;

export const setupIntegrationTest = async (): Promise<IntegrationTestSetupResult> => {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  return {
    db,
    logger,
  };
};
