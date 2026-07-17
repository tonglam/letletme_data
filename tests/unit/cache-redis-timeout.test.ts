import { afterAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

import { createRedisSingleton } from '../../src/cache/singleton';

/**
 * FP-03: a black-holed Redis (TCP accepts, never answers) must not stall the
 * app — connect/ping/commands have to fail within ~5s so cache callers fall
 * back to the database.
 */

const blackHole = net.createServer(() => {
  // Accept the socket and stay silent forever.
});
const sockets = new Set<net.Socket>();
blackHole.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

let blackHolePort = 0;

const startBlackHole = async (): Promise<void> => {
  if (blackHolePort !== 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    blackHole.listen(0, '127.0.0.1', () => resolve());
  });
  blackHolePort = (blackHole.address() as AddressInfo).port;
};

afterAll(() => {
  for (const socket of sockets) {
    socket.destroy();
  }
  blackHole.close();
});

describe('redis singleton against a black-holed server', () => {
  test(
    'connect() rejects within ~5s instead of hanging',
    async () => {
      await startBlackHole();
      const singleton = createRedisSingleton({ host: '127.0.0.1', port: blackHolePort, db: 1 });
      try {
        const start = performance.now();
        await expect(singleton.connect()).rejects.toThrow();
        const elapsed = performance.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(4900);
        expect(elapsed).toBeLessThan(10_000);
        expect(singleton.isHealthy()).toBe(false);
        expect(singleton.getStatus()).toEqual({ connected: false, connecting: false });
      } finally {
        await singleton.disconnect();
      }
    },
    { timeout: 20_000 },
  );

  test(
    'getClient() rejects within ~5s (callers then fall back to DB)',
    async () => {
      await startBlackHole();
      const singleton = createRedisSingleton({ host: '127.0.0.1', port: blackHolePort, db: 1 });
      try {
        const start = performance.now();
        await expect(singleton.getClient()).rejects.toThrow();
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        await singleton.disconnect();
      }
    },
    { timeout: 20_000 },
  );

  test(
    'concurrent connect() calls share one attempt and all reject',
    async () => {
      await startBlackHole();
      const singleton = createRedisSingleton({ host: '127.0.0.1', port: blackHolePort, db: 1 });
      try {
        const start = performance.now();
        const results = await Promise.allSettled([
          singleton.connect(),
          singleton.connect(),
          singleton.connect(),
        ]);
        const elapsed = performance.now() - start;
        for (const result of results) {
          expect(result.status).toBe('rejected');
        }
        // One shared attempt (~5s), not three sequential ones (~15s)
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        await singleton.disconnect();
      }
    },
    { timeout: 20_000 },
  );

  test(
    'refused connection (closed port) rejects fast, not after retries',
    async () => {
      const singleton = createRedisSingleton({ host: '127.0.0.1', port: 1, db: 1 });
      try {
        const start = performance.now();
        await expect(singleton.connect()).rejects.toThrow();
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(5000);
      } finally {
        await singleton.disconnect();
      }
    },
    { timeout: 20_000 },
  );
});
