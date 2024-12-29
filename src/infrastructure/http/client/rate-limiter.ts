/**
 * Rate Limiter Implementation
 * @module infrastructure/http/client/rate-limiter
 */

import { ERROR_CONFIG, ErrorCode, HTTP_STATUS } from '../../../config/http/http.config';
import { createErrorFromStatus } from './utils';

/**
 * Configuration interface for the rate limiter
 */
export interface RateLimiterConfig {
  readonly tokensPerInterval: number; // Number of tokens added per interval
  readonly interval: number; // Interval in milliseconds
  readonly capacity: number; // Maximum number of tokens that can be stored
}

/**
 * Token Bucket Rate Limiter
 * Implements the token bucket algorithm for rate limiting
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = {
      tokensPerInterval: config.tokensPerInterval,
      interval: config.interval,
      capacity: config.capacity,
    };
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Attempts to consume tokens from the bucket
   * @param tokens Number of tokens to consume
   * @returns true if tokens were consumed, false otherwise
   */
  public tryConsume(tokens = 1): boolean {
    this.refillTokens();

    if (this.tokens < tokens) {
      return false;
    }

    this.tokens -= tokens;
    return true;
  }

  /**
   * Consumes tokens from the bucket or throws an error if not enough tokens
   * @param tokens Number of tokens to consume
   * @throws {APIError} if rate limit is exceeded
   */
  public consume(tokens = 1): void {
    if (!this.tryConsume(tokens)) {
      throw createErrorFromStatus(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        ERROR_CONFIG[ErrorCode.RATE_LIMIT_EXCEEDED].message,
        {
          remainingTokens: this.tokens,
          requestedTokens: tokens,
          nextRefillIn: this.getNextRefillTime(),
        },
      );
    }
  }

  /**
   * Returns the current number of available tokens
   */
  public getAvailableTokens(): number {
    this.refillTokens();
    return this.tokens;
  }

  /**
   * Returns time in milliseconds until next token refill
   */
  public getNextRefillTime(): number {
    const now = Date.now();
    const timeSinceLastRefill = now - this.lastRefill;
    return Math.max(0, this.config.interval - timeSinceLastRefill);
  }

  /**
   * Refills tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const timeSinceLastRefill = now - this.lastRefill;

    if (timeSinceLastRefill < this.config.interval) {
      return;
    }

    const intervals = Math.floor(timeSinceLastRefill / this.config.interval);
    const tokensToAdd = intervals * this.config.tokensPerInterval;

    this.tokens = Math.min(this.config.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now - (timeSinceLastRefill % this.config.interval);
  }
}

/**
 * Creates a rate limiter with default configuration
 */
export function createRateLimiter(config?: Partial<RateLimiterConfig>): RateLimiter {
  const defaultConfig: RateLimiterConfig = {
    tokensPerInterval: 10, // 10 tokens per interval
    interval: 1000, // 1 second interval
    capacity: 10, // Maximum 10 tokens
  };

  return new RateLimiter({ ...defaultConfig, ...config });
}

/**
 * Higher-order function for rate limiting any async function
 */
export function withRateLimit<Args extends unknown[], Return>(
  fn: (...args: Args) => Promise<Return>,
  rateLimiter: RateLimiter,
): (...args: Args) => Promise<Return> {
  return async (...args: Args): Promise<Return> => {
    rateLimiter.consume();
    return await fn(...args);
  };
}
