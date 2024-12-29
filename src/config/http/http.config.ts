/**
 * HTTP client configuration constants
 * @const {Readonly<{REQUESTS_PER_MINUTE: number, BURST_SIZE: number}>}
 */
export const RATE_LIMIT = {
  REQUESTS_PER_MINUTE: 60,
  BURST_SIZE: 10,
} as const;

/**
 * HTTP client configuration settings
 * @const {Readonly<{TIMEOUT: Object, RETRY: Object, CACHE: Object, STATUS: Object, HEADERS: Object, ERROR: Object}>}
 */
export const HTTP_CONFIG = {
  /**
   * @const {Readonly<{DEFAULT: number, LONG: number, SHORT: number}>}
   */
  TIMEOUT: {
    DEFAULT: 30000,
    LONG: 60000,
    SHORT: 5000,
  },

  /**
   * @const {Readonly<{DEFAULT_ATTEMPTS: number, MAX_ATTEMPTS: number, BASE_DELAY: number, MAX_DELAY: number, JITTER_MAX: number}>}
   */
  RETRY: {
    DEFAULT_ATTEMPTS: 3,
    MAX_ATTEMPTS: 5,
    BASE_DELAY: 1000,
    MAX_DELAY: 10000,
    JITTER_MAX: 100,
  },

  /**
   * @const {Readonly<{TIMESTAMP_PARAM: string}>}
   */
  CACHE: {
    TIMESTAMP_PARAM: '_t',
  },

  /**
   * @const {Readonly<{OK_MIN: number, OK_MAX: number, CLIENT_ERROR_MIN: number, CLIENT_ERROR_MAX: number, SERVER_ERROR_MIN: number, SERVER_ERROR_MAX: number}>}
   */
  STATUS: {
    OK_MIN: 200,
    OK_MAX: 299,
    CLIENT_ERROR_MIN: 400,
    CLIENT_ERROR_MAX: 499,
    SERVER_ERROR_MIN: 500,
    SERVER_ERROR_MAX: 599,
  },

  /**
   * @const {Readonly<Record<string, string>>}
   */
  HEADERS: {
    DEFAULT_USER_AGENT:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ACCEPT: 'application/json',
    CONTENT_TYPE: 'application/json',
    CACHE_CONTROL: 'no-cache, no-store, must-revalidate',
    PRAGMA: 'no-cache',
    EXPIRES: '0',
    ACCEPT_LANGUAGE: 'en-US,en;q=0.9',
    SEC_CH_UA: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    SEC_CH_UA_MOBILE: '?0',
    SEC_CH_UA_PLATFORM: '"macOS"',
    SEC_FETCH_DEST: 'empty',
    SEC_FETCH_MODE: 'cors',
    SEC_FETCH_SITE: 'same-site',
  },

  /**
   * @const {Readonly<{INVALID_REQUEST: string, UNKNOWN_ERROR: string, INTERNAL_ERROR: string, RETRY_EXHAUSTED: string}>}
   */
  ERROR: {
    INVALID_REQUEST: 'INVALID_REQUEST',
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  },
} as const;

/**
 * Type for timeout configuration keys
 * @type {keyof typeof HTTP_CONFIG.TIMEOUT}
 */
export type HTTPTimeout = keyof typeof HTTP_CONFIG.TIMEOUT;

/**
 * Type for error codes
 * @type {(typeof HTTP_CONFIG.ERROR)[keyof typeof HTTP_CONFIG.ERROR]}
 */
export type HTTPErrorCode = (typeof HTTP_CONFIG.ERROR)[keyof typeof HTTP_CONFIG.ERROR];

/**
 * Type for rate limit configuration
 * @type {typeof RATE_LIMIT}
 */
export type RateLimit = typeof RATE_LIMIT;
