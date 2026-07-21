import { describe, expect, test } from 'bun:test';

import { getHttpErrorLogLevel, getHttpRequestLogContext } from '../../src/utils/http-logging';

describe('HTTP logging policy', () => {
  test('suppresses health checks', () => {
    const health = new Request('http://127.0.0.1:3000/health?source=docker');
    const ready = new Request('http://127.0.0.1:3000/ready?source=monitor');

    expect(getHttpRequestLogContext(health)).toBeNull();
    expect(getHttpRequestLogContext(ready)).toBeNull();
  });

  test('keeps only method and pathname for debug request logs', () => {
    const request = new Request('https://api.letletme.top/players?token=secret', {
      method: 'POST',
      headers: { 'user-agent': 'test-agent' },
    });

    expect(getHttpRequestLogContext(request)).toEqual({
      method: 'POST',
      pathname: '/players',
    });
  });

  test('classifies expected and unexpected HTTP errors', () => {
    expect(getHttpErrorLogLevel('NOT_FOUND')).toBe('debug');
    expect(getHttpErrorLogLevel('VALIDATION')).toBe('warn');
    expect(getHttpErrorLogLevel('INTERNAL_SERVER_ERROR')).toBe('error');
  });
});
