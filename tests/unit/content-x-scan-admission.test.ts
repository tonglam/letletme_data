import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  parseContentXScanAdmissionArguments,
  CONTENT_X_SCAN_QUEUE,
  DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS,
  DEPLOY_QUEUE_ADMISSION_REASON,
  DEPLOY_QUEUE_ADMISSION_TTL_SECONDS,
} from '../../scripts/assert-queue-quiescence';
import { parseContentXScanConsumerModeArguments } from '../../scripts/set-content-x-scan-consumer-mode';
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

  function runConsumerControlShell(body: string): ReturnType<typeof Bun.spawnSync> {
    const script = String.raw`
set -euo pipefail
event_file=$(mktemp)
pause_file=$(mktemp)
FAIL_OPEN=false
rm -f "$pause_file"
trap 'rm -f "$event_file" "$pause_file"' EXIT
source scripts/deploy-state-machine.sh
compose() {
  local args="$*"
  if [[ "$args" == *"set-content-x-scan-consumer-mode.ts --mode STATUS"* ]]; then
    local paused=false
    [[ -e "$pause_file" ]] && paused=true
    printf 'STATUS\n' >>"$event_file"
    printf '{"contractVersion":"content-x-consumer-v1","paused":%s}\n' "$paused"
    return 0
  fi
  if [[ "$args" == *"set-content-x-scan-consumer-mode.ts --mode PAUSE"* ]]; then
    touch "$pause_file"
    printf 'PAUSE\n' >>"$event_file"
    printf '%s\n' '{"contractVersion":"content-x-consumer-v1","paused":true}'
    return 0
  fi
  if [[ "$args" == *"set-content-x-scan-consumer-mode.ts --mode RESUME"* ]]; then
    rm -f "$pause_file"
    printf 'RESUME\n' >>"$event_file"
    printf '%s\n' '{"contractVersion":"content-x-consumer-v1","paused":false}'
    return 0
  fi
  if [[ "$args" == *"--admission-mode OPEN"* ]]; then
    [[ "$FAIL_OPEN" = true ]] && return 1
    printf 'OPEN\n' >>"$event_file"
    printf '%s\n' '{"contractVersion":"queue-admission-v2","changed":true}'
    return 0
  fi
  return 1
}
${body}
cat "$event_file"
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

  test('parses the explicit consumer pause protocol', () => {
    expect(parseContentXScanConsumerModeArguments(['--mode', 'STATUS'])).toEqual({
      mode: 'STATUS',
    });
    expect(parseContentXScanConsumerModeArguments(['--mode', 'PAUSE'])).toEqual({
      mode: 'PAUSE',
    });
    expect(parseContentXScanConsumerModeArguments(['--mode', 'RESUME'])).toEqual({
      mode: 'RESUME',
    });
  });

  test('restores only the deployment-owned pause and opens admission first', () => {
    const result = runConsumerControlShell(String.raw`
pause_content_x_scan_consumer_for_deploy
DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED=true
restore_content_x_deploy_controls
[[ ! -e "$pause_file" ]]
[[ "$DEPLOY_CONTENT_X_SCAN_CONSUMER_PAUSED" = false ]]
[[ "$DEPLOY_CONTENT_X_SCAN_CONSUMER_PAUSE_OWNED" = false ]]
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('STATUS\nPAUSE\nOPEN\nRESUME');
  });

  test('preserves an externally paused consumer', () => {
    const result = runConsumerControlShell(String.raw`
touch "$pause_file"
pause_content_x_scan_consumer_for_deploy
restore_content_x_deploy_controls
[[ -e "$pause_file" ]]
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('STATUS');
    expect(result.stdout?.toString() ?? '').not.toContain('RESUME');
  });

  test('keeps the consumer paused when admission restoration fails', () => {
    const result = runConsumerControlShell(String.raw`
pause_content_x_scan_consumer_for_deploy
DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED=true
export FAIL_OPEN=true
    if restore_content_x_deploy_controls; then exit 1; fi
    [[ -e "$pause_file" ]]
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').not.toContain('RESUME');
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

  test('preserves the local Compose context in a setsid probe', () => {
    const script = String.raw`
set -euo pipefail
PROJECT_DIR=/tmp/letletme-data-compose-context
COMPOSE_FILE=compose.production.yml
COMPOSE_BIN='compose-wrapper --project-name letletme-data'
IFS=' ' read -r -a COMPOSE_CMD <<<"$COMPOSE_BIN"
export APP_IMAGE=letletme-data:test
source scripts/deploy-state-machine.sh
compose() {
  [[ "$PROJECT_DIR" == /tmp/letletme-data-compose-context ]]
  [[ "$COMPOSE_FILE" == compose.production.yml ]]
  [[ "$COMPOSE_BIN" == 'compose-wrapper --project-name letletme-data' ]]
  [[ "\${COMPOSE_CMD[*]}" == 'compose-wrapper --project-name letletme-data' ]]
  [[ "$APP_IMAGE" == letletme-data:test ]]
  return 0
}
output_file=$(mktemp)
set +e
run_scoped_queue_quiescence_probe "$output_file" 1
result=$?
set -e
printf 'result=%s\n' "$result"
cat "$output_file"
`;
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('result=0');
  });
});
