import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { getConfig, resetConfigForTests } from '../../src/utils/config';
import { sendWeChatBotNotification, WeChatNotificationError } from '../../src/utils/notify';

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'WECHAT_NOTIFICATION_URL',
  'WECHAT_NOTIFICATION_API_TOKEN',
  'CACHE_REDIS_HOST',
  'CACHE_REDIS_PORT',
  'CACHE_REDIS_DB',
  'QUEUE_REDIS_HOST',
  'QUEUE_REDIS_PORT',
  'QUEUE_REDIS_DB',
  'ENABLE_AUTH',
  'DATA_API_KEY_HASHES',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://localhost/notify-test';
  process.env.WECHAT_NOTIFICATION_URL = 'https://bot.example.test/notification';
  process.env.WECHAT_NOTIFICATION_API_TOKEN = 'n'.repeat(32);
  resetConfigForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests();
});

describe('WeChat notification caller', () => {
  test('sends Bearer and a stable idempotency key without logging payload', async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return new Response('{}', { status: 200, headers: { 'X-Request-Id': 'req-1' } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendWeChatBotNotification('freshness alert', ['self']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string | URL | Request, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${'n'.repeat(32)}`);
    expect(headers.get('Idempotency-Key')).toMatch(/^data-notify:[a-f0-9]{64}$/);
    expect(JSON.parse(String(init.body))).toEqual({
      type: 'text',
      targets: ['self'],
      text: 'freshness alert',
    });
  });

  test('classifies authentication failures without exposing the response body', async () => {
    globalThis.fetch = mock(
      async () => new Response('secret provider response', { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(sendWeChatBotNotification('alert', ['self'])).rejects.toMatchObject({
      category: 'authentication',
      status: 401,
    });
  });

  test('rejects invalid caller-supplied idempotency keys before network access', async () => {
    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      sendWeChatBotNotification('alert', ['self'], { idempotencyKey: 'bad key' }),
    ).rejects.toBeInstanceOf(WeChatNotificationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('treats a blank WeChat token as unset so local example env can boot', async () => {
    process.env.WECHAT_NOTIFICATION_API_TOKEN = '';
    process.env.WECHAT_NOTIFICATION_URL = '';
    process.env.ENABLE_AUTH = 'false';
    resetConfigForTests();

    const config = getConfig();
    expect(config.WECHAT_NOTIFICATION_API_TOKEN).toBeUndefined();
    expect(config.WECHAT_NOTIFICATION_URL).toBeUndefined();

    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await sendWeChatBotNotification('alert', ['self']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fails closed when production has a URL but no token', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WECHAT_NOTIFICATION_API_TOKEN = '';
    process.env.CACHE_REDIS_HOST = 'cache.example.test';
    process.env.CACHE_REDIS_PORT = '6379';
    process.env.CACHE_REDIS_DB = '0';
    process.env.QUEUE_REDIS_HOST = 'queue.example.test';
    process.env.QUEUE_REDIS_PORT = '6379';
    process.env.QUEUE_REDIS_DB = '1';
    process.env.ENABLE_AUTH = 'true';
    process.env.DATA_API_KEY_HASHES = 'a'.repeat(64);
    resetConfigForTests();

    await expect(sendWeChatBotNotification('alert', ['self'])).rejects.toThrow(
      'WECHAT_NOTIFICATION_API_TOKEN is required',
    );
  });
});
