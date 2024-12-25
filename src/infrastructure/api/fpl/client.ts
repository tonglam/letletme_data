import axios from 'axios';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import pino from 'pino';
import { BootstrapApi } from '../../../domains/bootstrap/operations';
import { BootStrapResponse, toDomainBootStrap } from '../../../types/bootStrap.type';
import { Event } from '../../../types/events.type';
import { Phase } from '../../../types/phases.type';
import { setupRequestInterceptors, setupResponseInterceptors } from '../common/client/interceptors';
import { HTTPClientContext, HTTPConfig, RetryConfig } from '../common/types';
import { HTTP_CONFIG } from '../config/http.config';
import { BASE_URLS, FPL_API_CONFIG } from './config';

const defaultRetryConfig: RetryConfig = {
  attempts: HTTP_CONFIG.RETRY.DEFAULT_ATTEMPTS,
  baseDelay: HTTP_CONFIG.RETRY.BASE_DELAY,
  maxDelay: HTTP_CONFIG.RETRY.MAX_DELAY,
  shouldRetry: (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      return status === 429 || (status ? status >= 500 && status < 600 : true);
    }
    return true;
  },
};

const defaultConfig: HTTPConfig = {
  baseURL: BASE_URLS.FPL,
  timeout: HTTP_CONFIG.TIMEOUT.DEFAULT,
  headers: {
    'User-Agent': HTTP_CONFIG.HEADERS.DEFAULT_USER_AGENT,
    Accept: HTTP_CONFIG.HEADERS.ACCEPT,
    'Content-Type': HTTP_CONFIG.HEADERS.CONTENT_TYPE,
    'Cache-Control': HTTP_CONFIG.HEADERS.CACHE_CONTROL,
    Pragma: HTTP_CONFIG.HEADERS.PRAGMA,
    Expires: HTTP_CONFIG.HEADERS.EXPIRES,
  },
  retry: defaultRetryConfig,
};

export const createFPLClient = (): BootstrapApi => {
  const client = axios.create(defaultConfig);
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  const context: HTTPClientContext = {
    client,
    logger,
    config: defaultConfig,
    retryConfig: defaultRetryConfig,
  };

  // Set up interceptors
  setupRequestInterceptors(context)();
  setupResponseInterceptors(context)();

  return {
    getBootstrapData: async (): Promise<Phase[] | null> => {
      try {
        const response = await client.get<BootStrapResponse>(FPL_API_CONFIG.bootstrap.static);
        return pipe(
          response.data,
          toDomainBootStrap,
          E.fold(
            (error) => {
              logger.error({ error }, 'Failed to transform bootstrap data');
              return null;
            },
            (data) => data.phases as Phase[],
          ),
        );
      } catch (error) {
        logger.error({ error }, 'Failed to fetch bootstrap data');
        return null;
      }
    },
    getBootstrapEvents: async (): Promise<Event[] | null> => {
      try {
        const response = await client.get<BootStrapResponse>(FPL_API_CONFIG.bootstrap.static);
        return pipe(
          response.data,
          toDomainBootStrap,
          E.fold(
            (error) => {
              logger.error({ error }, 'Failed to transform bootstrap events');
              return null;
            },
            (data) => data.events as Event[],
          ),
        );
      } catch (error) {
        logger.error({ error }, 'Failed to fetch bootstrap events');
        return null;
      }
    },
  };
};
