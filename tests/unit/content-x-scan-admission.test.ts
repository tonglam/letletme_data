import { describe, expect, test } from 'bun:test';

import {
  parseContentXScanAdmissionArguments,
  CONTENT_X_SCAN_QUEUE,
  DEPLOY_QUEUE_ADMISSION_REASON,
  DEPLOY_QUEUE_ADMISSION_TTL_SECONDS,
} from '../../scripts/set-content-x-scan-admission';

describe('content X deployment admission command', () => {
  test('pins the queue and bounded deployment TTL', () => {
    expect(CONTENT_X_SCAN_QUEUE).toBe('content-x-scan');
    expect(DEPLOY_QUEUE_ADMISSION_TTL_SECONDS).toBe(900);
    expect(DEPLOY_QUEUE_ADMISSION_REASON).toBe('DEPLOY_QUEUE_QUIESCENCE');
  });

  test('parses both supported admission modes', () => {
    expect(parseContentXScanAdmissionArguments(['--mode', 'DRAIN_ONLY'])).toEqual({
      mode: 'DRAIN_ONLY',
    });
    expect(parseContentXScanAdmissionArguments(['--mode=OPEN'])).toEqual({ mode: 'OPEN' });
  });

  test('rejects unknown, missing, repeated and invalid arguments', () => {
    for (const argv of [
      [],
      ['--unknown', 'OPEN'],
      ['--mode'],
      ['--mode', 'DRAIN_ONLY', '--mode', 'OPEN'],
      ['--mode', 'drain-only'],
      ['--mode=DRAIN_ONLY', 'extra'],
    ]) {
      expect(() => parseContentXScanAdmissionArguments(argv)).toThrow();
    }
  });
});
