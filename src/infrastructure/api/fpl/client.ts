import axios from 'axios';
import pino from 'pino';
import { BootstrapApi } from '../../../domains/bootstrap/operations';
import { Phase, PhaseId, PrismaPhase } from '../../../types/phase.type';
import { setupRequestInterceptors, setupResponseInterceptors } from '../common/client/interceptors';
import { HTTPClientContext, HTTPConfig, RetryConfig } from '../common/types';
import { HTTP_CONFIG } from '../config/http.config';
import { BASE_URLS, FPL_API_CONFIG } from './config';

// Using snake_case for API response to match FPL API format
type APIPhase = Omit<
  PrismaPhase,
  'id' | 'startEvent' | 'stopEvent' | 'highestScore' | 'createdAt'
> & {
  id: number;
  start_event: number;
  stop_event: number;
  highest_score: number | null;
};

interface BootstrapResponse {
  phases: APIPhase[];
}

const defaultRetryConfig: RetryConfig = {
  attempts: HTTP_CONFIG.RETRY.DEFAULT_ATTEMPTS,
  baseDelay: HTTP_CONFIG.RETRY.BASE_DELAY,
  maxDelay: HTTP_CONFIG.RETRY.MAX_DELAY,
  shouldRetry: (error: Error) => {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      return status ? status >= 500 && status < 600 : true;
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

const transformPhase = (data: APIPhase): Phase => ({
  id: data.id as PhaseId,
  name: data.name,
  startEvent: data.start_event,
  stopEvent: data.stop_event,
  highestScore: data.highest_score,
});

export const createFPLClient = (): BootstrapApi => {
  const client = axios.create(defaultConfig);

  const context: HTTPClientContext = {
    client,
    logger: pino({ level: process.env.LOG_LEVEL || 'info' }),
    config: defaultConfig,
    retryConfig: defaultRetryConfig,
  };

  // Set up interceptors
  setupRequestInterceptors(context)();
  setupResponseInterceptors(context)();

  return {
    getBootstrapData: async () => {
      try {
        const response = await client.get<BootstrapResponse>(FPL_API_CONFIG.bootstrap.static);
        return response.data.phases.map(transformPhase);
      } catch (error) {
        console.error('Failed to fetch bootstrap data:', error);
        return null;
      }
    },
  };
};
