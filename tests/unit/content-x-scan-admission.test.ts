import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  parseContentXScanAdmissionArguments,
  CONTENT_X_SCAN_QUEUE,
  DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS,
  DEPLOY_QUEUE_ADMISSION_REASON,
  DEPLOY_QUEUE_ADMISSION_TTL_SECONDS,
} from '../../scripts/set-content-x-scan-admission';
import { COMPARE_AND_SET_QUEUE_ADMISSION_LUA } from '../../src/services/queue-governance.service';

describe('content X deployment admission command', () => {
  test('pins the queue and bounded deployment TTL', () => {
    expect(CONTENT_X_SCAN_QUEUE).toBe('content-x-scan');
    expect(DEPLOY_QUEUE_ADMISSION_TTL_SECONDS).toBe(900);
    expect(DEPLOY_QUEUE_ADMISSION_REASON).toBe('DEPLOY_QUEUE_QUIESCENCE');
    expect(DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS).toBe(3);
  });

  test('uses an exact Redis CAS for deployment ownership and restoration', () => {
    const command = readFileSync('scripts/set-content-x-scan-admission.ts', 'utf8');
    expect(command).toContain('compareAndSetQueueAdmission');
    expect(command).not.toContain('setQueueAdmission');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('current ~= expected');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('expected ==');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('EX');
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
