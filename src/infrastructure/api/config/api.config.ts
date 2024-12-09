/**
 * API Environment configuration
 */
export const API_ENV = {
  development: 'development',
  production: 'production',
  test: 'test',
} as const;

export type ApiEnvironment = keyof typeof API_ENV;

/**
 * HTTP Timeout types
 */
export type HTTPTimeout = 'DEFAULT' | 'LONG' | 'SHORT';

/**
 * Base URLs for different environments
 */
export const BASE_URLS = {
  [API_ENV.development]: 'https://fantasy.premierleague.com/api',
  [API_ENV.production]: 'https://fantasy.premierleague.com/api',
  [API_ENV.test]: 'http://localhost:3000/mock/api',
} as const;

/**
 * API version configuration
 */
export const API_VERSION = {
  current: 'v1',
  supported: ['v1'] as const,
} as const;

/**
 * HTTP configuration
 */
export const HTTP_CONFIG = {
  TIMEOUT: {
    DEFAULT: 30000,
    LONG: 60000,
    SHORT: 5000,
  },
  RETRY: {
    DEFAULT_ATTEMPTS: 3,
    MAX_ATTEMPTS: 5,
    BASE_DELAY: 1000,
    MAX_DELAY: 10000,
    JITTER_MAX: 100,
  },
  STATUS: {
    OK_MIN: 200,
    OK_MAX: 299,
    CLIENT_ERROR_MIN: 400,
    SERVER_ERROR_MIN: 500,
  },
  HEADERS: {
    ACCEPT: 'application/json',
    CONTENT_TYPE: 'application/json',
    CACHE_CONTROL: 'no-cache, no-store, must-revalidate',
    PRAGMA: 'no-cache',
    EXPIRES: '0',
    DEFAULT_USER_AGENT:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  CACHE: {
    TIMESTAMP_PARAM: '_t',
  },
  ERROR: {
    INVALID_REQUEST: 'INVALID_REQUEST',
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  },
} as const;
