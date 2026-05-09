/**
 * Poll Redis `event:current` to see when the event-current-refresh job (or sync) updates it.
 *
 * The refresh cron runs every minute but only writes when the derived gameweek id changes
 * (see eventsCache.refreshCurrent). Most minutes the value stays the same.
 *
 * Run locally against the same Redis as the API (needs REDIS_* in env):
 *   bun scripts/monitor-event-current-redis.ts
 *   bun scripts/monitor-event-current-redis.ts --interval=15 --iterations=40
 *
 * On VPS (matches compose env):
 *   docker compose exec -T api bun scripts/monitor-event-current-redis.ts
 */
/* eslint-disable no-console -- CLI introspection output */
import 'dotenv/config';
import { createHash } from 'crypto';

import Redis from 'ioredis';

const KEY = 'event:current';

function parseArgs(): { intervalMs: number; iterations: number } {
  let intervalSec = 60;
  let iterations = 12;

  for (const raw of process.argv.slice(2)) {
    if (raw === '--help' || raw === '-h') {
      console.log(`Usage: bun scripts/monitor-event-current-redis.ts [--interval=N] [--iterations=N]

  --interval     Seconds between polls (default 60)
  --iterations   Stop after N polls; 0 = run forever (default 12)`);
      process.exit(0);
    }
    if (raw.startsWith('--interval=')) {
      intervalSec = Math.max(1, Number(raw.slice('--interval='.length)));
    }
    if (raw.startsWith('--iterations=')) {
      iterations = Math.max(0, Number(raw.slice('--iterations='.length)));
    }
  }

  return { intervalMs: intervalSec * 1000, iterations };
}

function shortHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 10);
}

function summarize(raw: string | null): { id: number | null; name?: string; fingerprint: string } {
  if (raw === null) {
    return { id: null, fingerprint: '(nil)' };
  }
  try {
    const o = JSON.parse(raw) as { id?: number; name?: string };
    return {
      id: typeof o.id === 'number' ? o.id : null,
      name: typeof o.name === 'string' ? o.name : undefined,
      fingerprint: shortHash(raw),
    };
  } catch {
    return { id: null, fingerprint: shortHash(raw) };
  }
}

async function main(): Promise<void> {
  const { intervalMs, iterations } = parseArgs();

  const host = process.env.REDIS_HOST ?? 'localhost';
  const port = Number(process.env.REDIS_PORT) || 6379;
  const password = process.env.REDIS_PASSWORD;
  const db = Number(process.env.REDIS_DB) || 0;

  const redis = new Redis({
    host,
    port,
    password,
    db,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });

  await redis.ping();
  console.log(
    JSON.stringify(
      {
        key: KEY,
        redis: `${host}:${port} db=${db}`,
        intervalSec: intervalMs / 1000,
        iterations: iterations === 0 ? 'until Ctrl+C' : iterations,
      },
      null,
      2,
    ),
  );

  let prev: string | null = null;
  let n = 0;

  const poll = async () => {
    const raw = await redis.get(KEY);
    const ttl = await redis.ttl(KEY);
    const ts = new Date().toISOString();
    const cur = summarize(raw);

    if (raw !== prev) {
      console.log(
        JSON.stringify({
          at: ts,
          change: true,
          ttl,
          ...cur,
          bytes: raw === null ? 0 : Buffer.byteLength(raw, 'utf8'),
        }),
      );
      prev = raw;
    } else {
      console.log(
        JSON.stringify({
          at: ts,
          change: false,
          ttl,
          ...cur,
        }),
      );
    }

    n += 1;
  };

  await poll();

  if (iterations === 0) {
    setInterval(() => {
      void poll();
    }, intervalMs);
    return;
  }

  while (n < iterations) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await poll();
  }

  await redis.quit();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
