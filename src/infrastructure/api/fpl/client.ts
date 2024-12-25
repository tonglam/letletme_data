import axios from 'axios';
import pino from 'pino';
import { BootstrapApi, BootstrapData } from '../../../domains/bootstrap/operations';
import { setupRequestInterceptors, setupResponseInterceptors } from '../common/client/interceptors';
import { HTTPClientContext, HTTPConfig, RetryConfig } from '../common/types';
import { BASE_URLS, FPL_API_CONFIG } from './config';

const defaultRetryConfig: RetryConfig = {
  attempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  shouldRetry: (error) => {
    if (error instanceof Error) {
      const status = parseInt(error.message, 10);
      return status === 429 || (status >= 500 && status < 600);
    }
    return false;
  },
};

const defaultConfig: HTTPConfig = {
  baseURL: BASE_URLS.FPL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  },
  retry: defaultRetryConfig,
};

export const createFPLClient = (): BootstrapApi => {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  const client = axios.create(defaultConfig);

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
    getBootstrapData: async () => {
      try {
        const response = await client.get<BootstrapData>(FPL_API_CONFIG.bootstrap.static);
        return response.data;
      } catch (error) {
        logger.error({ error }, 'Failed to fetch bootstrap data');
        return null;
      }
    },
  };
};
