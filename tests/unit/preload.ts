/**
 * Unit-test process fence.
 *
 * Bun loads dotenv files before test preloads. Override every connection
 * endpoint here so a developer's local `.env` can never make a unit test open
 * a real PostgreSQL or Redis connection. Integration tests do not use this
 * preload because they run through the explicit `test:integration` command.
 */

const integrationPathRequested = process.argv.some((argument) =>
  /(?:^|[\\/])tests[\\/]integration(?:[\\/]|$)/.test(argument),
);
const unitPathRequested = process.argv.some((argument) =>
  /(?:^|[\\/])tests[\\/]unit(?:[\\/]|$)/.test(argument),
);
if (integrationPathRequested && process.env.RUN_INTEGRATION !== '1') {
  throw new Error('Integration tests require RUN_INTEGRATION=1 and disposable infrastructure');
}

// Integration tests opt in explicitly and must retain their disposable
// Postgres/Redis endpoints and provider fixtures. A process that requests unit
// tests is always fenced, even when RUN_INTEGRATION=1 is present for a later
// command in a shell sequence such as `test:all`.
const unitProcess = unitPathRequested || !integrationPathRequested;
if (unitProcess) {
  const UNIT_DATABASE_URL = 'postgresql://unit:unit@127.0.0.1:1/unit';

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = UNIT_DATABASE_URL;
  process.env.CACHE_REDIS_HOST = '127.0.0.1';
  process.env.CACHE_REDIS_PORT = '1';
  process.env.CACHE_REDIS_DB = '9';
  process.env.CACHE_REDIS_PASSWORD = '';
  process.env.QUEUE_REDIS_HOST = '127.0.0.1';
  process.env.QUEUE_REDIS_PORT = '2';
  process.env.QUEUE_REDIS_DB = '10';
  process.env.QUEUE_REDIS_PASSWORD = '';

  // These values are consumed by optional adapters during module evaluation.
  // Remove them instead of allowing an ignored dotenv file to leak credentials
  // into a unit process. Tests that exercise an adapter set an explicit fixture
  // value in their own setup.
  for (const key of [
    'BUG_REPORT_CLEANUP_SECRET',
    'BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY',
    'FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY',
    'TELEGRAM_BOT_TOKEN',
    'WECHAT_NOTIFICATION_API_TOKEN',
    'SUPABASE_BUG_REPORT_BUCKET',
  ]) {
    delete process.env[key];
  }

  globalThis.fetch = (async () => {
    throw new Error('Unit tests cannot access the network; install a fetch mock for this case');
  }) as unknown as typeof fetch;
}
