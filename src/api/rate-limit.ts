import { Elysia } from 'elysia';

import { getConfig } from '../utils/config';
import { logWarn } from '../utils/logger';
import { SAFE_HTTP_METHODS } from './auth.policy';

/**
 * HTTP-layer rate limit for mutation methods (POST/PUT/PATCH/DELETE).
 *
 * Independent of ENABLE_AUTH: even with auth disabled, operational endpoints
 * (/jobs/* /trigger, /entry-sync/*, /fixtures/sync*) must not be floodable.
 * Better Auth routes (/api/auth) are excluded — the api-key plugin enforces
 * its own rate limit there (surfaced as 429 by the mutation auth guard).
 */

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

type Bucket = { windowStart: number; count: number };

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

export function createFixedWindowRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
  /** Hard cap on distinct keys (default 10_000). Overridable for tests. */
  maxTrackedKeys?: number;
}) {
  const { maxRequests, windowMs } = options;
  const maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  function sweepExpired(reference: number): void {
    for (const [key, bucket] of buckets) {
      if (reference - bucket.windowStart >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const timestamp = now();
      if (buckets.size >= maxTrackedKeys) {
        sweepExpired(timestamp);
      }

      const bucket = buckets.get(key);
      if (!bucket || timestamp - bucket.windowStart >= windowMs) {
        // Cap is hard: if every tracked key is still live, refuse new keys
        // rather than letting a burst of unique client IPs grow the map.
        if (!buckets.has(key) && buckets.size >= maxTrackedKeys) {
          return { allowed: false, retryAfterSeconds: 1 };
        }
        buckets.set(key, { windowStart: timestamp, count: 1 });
        return { allowed: true };
      }

      if (bucket.count < maxRequests) {
        bucket.count += 1;
        return { allowed: true };
      }

      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.windowStart + windowMs - timestamp) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    },

    trackedKeys(): number {
      return buckets.size;
    },
  };
}

export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

type GuardContext = {
  request: Request;
  set: { status?: number | string; headers: Record<string, string | number> };
  path: string;
};

export function mutationRateLimitGuard(maxPerMinute: number) {
  const limiter = createFixedWindowRateLimiter({
    maxRequests: maxPerMinute,
    windowMs: 60_000,
  });

  return ({ request, set, path }: GuardContext): { success: false; error: string } | undefined => {
    if (SAFE_HTTP_METHODS.has(request.method.toUpperCase())) {
      return undefined;
    }
    if (path.startsWith('/api/auth')) {
      return undefined;
    }

    const decision = limiter.check(getClientIp(request));
    if (!decision.allowed) {
      set.status = 429;
      set.headers['retry-after'] = String(decision.retryAfterSeconds);
      return { success: false, error: 'Too many requests' };
    }

    return undefined;
  };
}

export function registerMutationRateLimit(app: Elysia) {
  const { RATE_LIMIT_MUTATIONS_PER_MINUTE: maxPerMinute } = getConfig();

  if (maxPerMinute <= 0) {
    logWarn('Mutation rate limit disabled (RATE_LIMIT_MUTATIONS_PER_MINUTE<=0)');
    return app;
  }

  return app.onBeforeHandle(mutationRateLimitGuard(maxPerMinute));
}
