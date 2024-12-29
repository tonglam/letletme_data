// Cache Utility Functions
//
// Provides utility functions for cache operations.
// Includes key generation and error handling utilities.

import type { CacheError, CacheErrorType } from './types';

// Generates a cache key with optional prefix
// Ensures consistent key format across the application
export const generateCacheKey = (key: string, prefix?: string): string =>
  prefix ? `${prefix}:${key}` : key;

// Creates a cache error with specified type and message
// Optionally includes the original error cause
export const createCacheError = (
  type: CacheErrorType,
  message: string,
  cause?: unknown,
): CacheError => ({
  type,
  message,
  cause,
});
