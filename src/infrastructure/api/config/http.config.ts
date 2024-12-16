/**
 * HTTP Client Configuration Module
 *
 * Contains all configuration values and constants for the HTTP client.
 * This centralized configuration allows for easy maintenance and consistency
 * across the application.
 *
 * @module infrastructure/api/config/http.config
 */

/**
 * Rate limiting configuration
 * Controls request frequency to external APIs
 */
export const RATE_LIMIT = {
  REQUESTS_PER_MINUTE: 60,
  BURST_SIZE: 10,
} as const;

export const HTTP_CONFIG = {
  /**
   * Timeout settings in milliseconds
   * Different timeouts for different types of operations
   */
  TIMEOUT: {
    DEFAULT: 30_000, // Standard timeout for most operations
    LONG: 60_000, // Extended timeout for complex operations
    SHORT: 5_000, // Quick timeout for simple operations
  },

  /**
   * Retry mechanism configuration
   * Implements exponential backoff with jitter
   */
  RETRY: {
    DEFAULT_ATTEMPTS: 3, // Standard number of retry attempts
    MAX_ATTEMPTS: 5, // Maximum allowed retry attempts
    BASE_DELAY: 1_000, // Initial delay between retries (1 second)
    MAX_DELAY: 10_000, // Maximum delay between retries (10 seconds)
    JITTER_MAX: 100, // Maximum random jitter to add to delay
  },

  /**
   * Cache control settings
   * Used to prevent caching of dynamic content
   */
  CACHE: {
    TIMESTAMP_PARAM: '_t', // Query parameter for cache busting
  },

  /**
   * HTTP Status code ranges
   * Used for response validation and error handling
   */
  STATUS: {
    OK_MIN: 200, // Minimum success status code
    OK_MAX: 299, // Maximum success status code
    CLIENT_ERROR_MIN: 400, // Minimum client error status code
    CLIENT_ERROR_MAX: 499, // Maximum client error status code
    SERVER_ERROR_MIN: 500, // Minimum server error status code
    SERVER_ERROR_MAX: 599, // Maximum server error status code
  },

  /**
   * Default HTTP headers
   * Applied to all requests unless overridden
   */
  HEADERS: {
    DEFAULT_USER_AGENT:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ACCEPT: 'application/json',
    CONTENT_TYPE: 'application/json',
    CACHE_CONTROL: 'no-cache, no-store, must-revalidate',
    PRAGMA: 'no-cache',
    EXPIRES: '0',
  },

  /**
   * Error codes for API errors
   * Used for consistent error handling across the application
   */
  ERROR: {
    INVALID_REQUEST: 'INVALID_REQUEST', // Missing or invalid request parameters
    UNKNOWN_ERROR: 'UNKNOWN_ERROR', // Unhandled or unexpected errors
    INTERNAL_ERROR: 'INTERNAL_ERROR', // Internal server errors
    RETRY_EXHAUSTED: 'RETRY_EXHAUSTED', // Maximum retry attempts reached
  },
} as const;

/**
 * Type for timeout configuration keys
 * Used for type-safe timeout selection
 */
export type HTTPTimeout = keyof typeof HTTP_CONFIG.TIMEOUT;

/**
 * Type for error codes
 * Ensures type safety when working with error codes
 */
export type HTTPErrorCode = (typeof HTTP_CONFIG.ERROR)[keyof typeof HTTP_CONFIG.ERROR];

/**
 * Type for rate limit configuration
 * Ensures type safety when working with rate limits
 */
export type RateLimit = typeof RATE_LIMIT;
