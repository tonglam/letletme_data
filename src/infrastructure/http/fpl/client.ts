import { pipe } from 'fp-ts/function';
import * as IOE from 'fp-ts/IOEither';
import pino from 'pino';
import { createHTTPClient } from '../common/client';
import { HTTP_CONFIG } from '../config/http.config';
import { BASE_URLS } from './config/api.config';
import { createFPLEndpoints } from './endpoints';
import { FPLEndpoints } from './types';

export const createFPLClient = (): FPLEndpoints => {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  // Create HTTP client with FPL-specific configuration
  const httpClient = pipe(
    createHTTPClient({
      baseURL: BASE_URLS.FPL,
      timeout: HTTP_CONFIG.TIMEOUT.DEFAULT,
      logger,
    }),
    IOE.getOrElse((error) => {
      throw error;
    }),
  )();

  // Create and return all FPL endpoints
  return createFPLEndpoints(httpClient);
};