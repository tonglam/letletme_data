import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';

import {
  createFixedWindowRateLimiter,
  getClientIp,
  mutationRateLimitGuard,
} from '../../src/api/rate-limit';

describe('createFixedWindowRateLimiter', () => {
  test('allows up to maxRequests within a window, then blocks with retry-after', () => {
    let now = 1_000_000;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.check('ip-1')).toEqual({ allowed: true });
    expect(limiter.check('ip-1')).toEqual({ allowed: true });

    now += 30_000; // halfway through the window
    const blocked = limiter.check('ip-1');
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBe(30);
    }
  });

  test('resets the count after the window elapses', () => {
    let now = 1_000_000;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.check('ip-1').allowed).toBe(true);
    expect(limiter.check('ip-1').allowed).toBe(false);

    now += 61_000;
    expect(limiter.check('ip-1').allowed).toBe(true);
  });

  test('tracks keys independently', () => {
    const limiter = createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 });

    expect(limiter.check('ip-1').allowed).toBe(true);
    expect(limiter.check('ip-2').allowed).toBe(true);
    expect(limiter.check('ip-1').allowed).toBe(false);
  });

  test('retry-after is at least 1 second at the window boundary', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.check('ip-1').allowed).toBe(true);
    now = 59_500;
    const blocked = limiter.check('ip-1');
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBe(1);
    }
  });

  test('does not grow beyond maxTrackedKeys when all buckets are live', () => {
    let now = 1_000_000;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 5,
      windowMs: 60_000,
      maxTrackedKeys: 3,
      now: () => now,
    });

    expect(limiter.check('ip-1').allowed).toBe(true);
    expect(limiter.check('ip-2').allowed).toBe(true);
    expect(limiter.check('ip-3').allowed).toBe(true);
    expect(limiter.trackedKeys()).toBe(3);

    // All live — new unique key refused, map size unchanged
    expect(limiter.check('ip-4').allowed).toBe(false);
    expect(limiter.trackedKeys()).toBe(3);

    // Existing keys still served
    expect(limiter.check('ip-1').allowed).toBe(true);

    // After expiry, sweep frees room for a new key
    now += 61_000;
    expect(limiter.check('ip-4').allowed).toBe(true);
  });
});

describe('getClientIp', () => {
  test('prefers x-real-ip over client-spoofable x-forwarded-for', () => {
    const request = new Request('http://localhost/', {
      headers: {
        'x-forwarded-for': '203.0.113.1, 10.0.0.1',
        'x-real-ip': '198.51.100.2',
      },
    });
    expect(getClientIp(request)).toBe('198.51.100.2');
  });

  test('uses the last x-forwarded-for hop when x-real-ip is absent', () => {
    // nginx $proxy_add_x_forwarded_for appends the real peer at the end
    const request = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
    });
    expect(getClientIp(request)).toBe('10.0.0.1');
  });

  test('falls back to unknown', () => {
    expect(getClientIp(new Request('http://localhost/'))).toBe('unknown');
  });
});

describe('mutationRateLimitGuard', () => {
  function buildApp(maxPerMinute: number) {
    return new Elysia()
      .onBeforeHandle(mutationRateLimitGuard(maxPerMinute))
      .get('/things', () => ({ ok: true }))
      .post('/things', () => ({ ok: true }))
      .post('/api/auth/api-key/create', () => ({ ok: true }));
  }

  const post = () =>
    new Request('http://localhost/things', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

  test('returns 429 with retry-after once the per-IP budget is spent', async () => {
    const app = buildApp(2);

    expect((await app.handle(post())).status).toBe(200);
    expect((await app.handle(post())).status).toBe(200);

    const limited = await app.handle(post());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(await limited.json()).toEqual({ success: false, error: 'Too many requests' });
  });

  test('does not limit safe methods', async () => {
    const app = buildApp(1);
    for (let i = 0; i < 5; i++) {
      expect((await app.handle(new Request('http://localhost/things'))).status).toBe(200);
    }
  });

  test('does not limit Better Auth routes (plugin enforces its own limit)', async () => {
    const app = buildApp(1);
    for (let i = 0; i < 3; i++) {
      const response = await app.handle(
        new Request('http://localhost/api/auth/api-key/create', { method: 'POST' }),
      );
      expect(response.status).toBe(200);
    }
  });
});
