import { describe, expect, test } from 'bun:test';

import { retentionDeadline, sanitizeBugReportClientMeta } from '../../src/domain/bug-report';
import { hashBugReportScreenshotLocator } from '../../src/repositories/bug-reports';

describe('bug report retention and diagnostics', () => {
  const created = new Date('2026-01-01T00:00:00.000Z');

  test('open and acknowledged reports keep the created-plus-180-day hard limit', () => {
    expect(retentionDeadline(created, 'open', null).toISOString()).toBe('2026-06-30T00:00:00.000Z');
    expect(retentionDeadline(created, 'ack', null).toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  test('closed reports use the earlier of the hard limit and close-plus-30 days', () => {
    expect(
      retentionDeadline(created, 'closed', new Date('2026-02-01T00:00:00.000Z')).toISOString(),
    ).toBe('2026-03-03T00:00:00.000Z');
    expect(
      retentionDeadline(created, 'closed', new Date('2026-06-15T00:00:00.000Z')).toISOString(),
    ).toBe('2026-06-30T00:00:00.000Z');
  });

  test('reopening clears the close deadline and diagnostics stay allowlisted', () => {
    expect(
      retentionDeadline(created, 'open', new Date('2026-02-01T00:00:00.000Z')).toISOString(),
    ).toBe('2026-06-30T00:00:00.000Z');
    expect(
      sanitizeBugReportClientMeta({
        route: 'pages/home/index/index',
        entryId: 123,
        deviceId: 'secret-device',
        operations: [
          { operation: 'Live', requestId: 'r1', message: 'https://example.com?token=x' },
        ],
      }),
    ).toEqual({
      route: 'pages/home/index/index',
      operations: [{ operation: 'Live', requestId: 'r1', message: '[url]' }],
    });
  });

  test('redacts values after sensitive diagnostic field names', () => {
    expect(
      sanitizeBugReportClientMeta({
        operations: [
          {
            operation: 'submit',
            message:
              'Authorization: Bearer super-secret token: Bearer token-secret deviceId: abc-123 entryId=987',
          },
        ],
      }),
    ).toEqual({
      operations: [
        {
          operation: 'submit',
          message: '[redacted] [redacted] [redacted] [redacted]',
        },
      ],
    });

    expect(
      sanitizeBugReportClientMeta({
        operations: [{ operation: 'submit', message: 'Authorization: Basic dXNlcjpwYXNz' }],
      }),
    ).toEqual({
      operations: [{ operation: 'submit', message: '[redacted]' }],
    });

    const quoted = sanitizeBugReportClientMeta({
      operations: [
        {
          operation: 'submit',
          message: '{"Authorization":"Bearer super-secret","deviceId":"abc"}',
        },
      ],
    });
    const quotedMessage = (quoted.operations as Array<{ message?: string }>)[0]?.message ?? '';
    expect(quotedMessage).not.toContain('super-secret');
    expect(quotedMessage).not.toContain('abc');
    expect(quotedMessage).toContain('[redacted]');

    const urlBeforeQuotedSecret = sanitizeBugReportClientMeta({
      operations: [
        {
          operation: 'submit',
          message: '{"url":"https://example.test","Authorization":"Bearer super-secret"}',
        },
      ],
    });
    const urlBeforeQuotedSecretMessage =
      (urlBeforeQuotedSecret.operations as Array<{ message?: string }>)[0]?.message ?? '';
    expect(urlBeforeQuotedSecretMessage).not.toContain('super-secret');
    expect(urlBeforeQuotedSecretMessage).toContain('[url]');
  });

  test('retention tombstones hash completed screenshot locators', () => {
    const locator =
      'https://legacy.example.test/avatar/bug.png?signature=secret-token&expires=9999999999';
    const digest = hashBugReportScreenshotLocator(locator);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('secret-token');
    expect(hashBugReportScreenshotLocator(locator)).toBe(digest);
    expect(hashBugReportScreenshotLocator(`${locator}&retry=1`)).not.toBe(digest);
  });
});
