import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  parseContentXScanAdmissionArguments,
  CONTENT_X_SCAN_QUEUE,
  DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS,
  DEPLOY_QUEUE_ADMISSION_REASON,
  DEPLOY_QUEUE_ADMISSION_TTL_SECONDS,
} from '../../scripts/assert-queue-quiescence';
import { COMPARE_AND_SET_QUEUE_ADMISSION_LUA } from '../../src/services/queue-governance.service';

describe('content X deployment admission command', () => {
  function runQueueProbeShell(composeBody: string): ReturnType<typeof Bun.spawnSync> {
    const script = String.raw`
set -euo pipefail
source scripts/deploy-state-machine.sh
compose() {
  ${composeBody}
}
output_file=$(mktemp)
set +e
run_scoped_queue_quiescence_probe "$output_file" 1
result=$?
set -e
printf 'result=%s\n' "$result"
cat "$output_file"
`;
    return Bun.spawnSync(['bash', '-c', script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  test('pins the queue and bounded deployment TTL', () => {
    expect(CONTENT_X_SCAN_QUEUE).toBe('content-x-scan');
    expect(DEPLOY_QUEUE_ADMISSION_TTL_SECONDS).toBe(900);
    expect(DEPLOY_QUEUE_ADMISSION_REASON).toBe('DEPLOY_QUEUE_QUIESCENCE');
    expect(DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS).toBe(3);
  });

  test('uses an exact Redis CAS for deployment ownership and restoration', () => {
    const command = readFileSync('scripts/assert-queue-quiescence.ts', 'utf8');
    expect(command).toContain('compareAndSetQueueAdmission');
    expect(command).not.toContain('setQueueAdmission');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('current ~= expected');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('expected ==');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('EX');
  });

  test('parses both supported admission modes', () => {
    expect(parseContentXScanAdmissionArguments(['--admission-mode', 'DRAIN_ONLY'])).toEqual({
      mode: 'DRAIN_ONLY',
    });
    expect(parseContentXScanAdmissionArguments(['--admission-mode=OPEN'])).toEqual({
      mode: 'OPEN',
    });
  });

  test('rejects unknown, missing, repeated and invalid arguments', () => {
    for (const argv of [
      [],
      ['--unknown', 'OPEN'],
      ['--admission-mode'],
      ['--admission-mode', 'DRAIN_ONLY', '--admission-mode', 'OPEN'],
      ['--admission-mode', 'drain-only'],
      ['--admission-mode=DRAIN_ONLY', 'extra'],
    ]) {
      expect(() => parseContentXScanAdmissionArguments(argv)).toThrow();
    }
  });

  test('bounds TERM-ignoring probes with a KILL cleanup', () => {
    const startedAt = Date.now();
    const result = runQueueProbeShell(String.raw`trap ':' TERM; sleep 30`);
    const elapsedMs = Date.now() - startedAt;
    const stdout = result.stdout?.toString() ?? '';
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('result=124');
    expect(stdout).toContain('scoped queue probe timed out after 1s');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test('keeps a successful scoped probe successful', () => {
    const result = runQueueProbeShell('return 0');
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('result=0');
  });
});
